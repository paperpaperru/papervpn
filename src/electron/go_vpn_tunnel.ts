// Copyright 2021 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from 'fs';
import {platform} from 'os';

import {powerMonitor} from 'electron';

import {ChildProcessHelper, ProcessTerminatedExitCodeError, ProcessTerminatedSignalError} from './process';
import {RoutingDaemon} from './routing_service';
import {VpnTunnel} from './vpn_tunnel';
import {pathToEmbeddedTun2socksBinary, pathToEmbeddedXrayBinary, pathToXrayConfigJson} from '../../client/infrastructure/electron/app_paths';
import {ShadowsocksSessionConfig, XraySessionConfig} from '../../client/src/www/app/tunnel';
import {TunnelStatus} from '../../client/src/www/app/tunnel';
import {ErrorCode, fromErrorCode, UnexpectedPluginError} from '../../client/src/www/model/errors';


const isLinux = platform() === 'linux';
const isWindows = platform() === 'win32';

const TUN2SOCKS_TAP_DEVICE_NAME = isLinux ? 'outline-tun0' : 'outline-tap0';
const TUN2SOCKS_TAP_DEVICE_IP = '10.0.85.2';
const TUN2SOCKS_VIRTUAL_ROUTER_IP = '10.0.85.1';
const TUN2SOCKS_VIRTUAL_ROUTER_NETMASK = '255.255.255.0';

// Cloudflare and Quad9 resolvers.
const DNS_RESOLVERS = ['1.1.1.1', '9.9.9.9'];

// Establishes a full-system VPN with the help of Outline's routing daemon and child process
// outline-go-tun2socks. The routing service modifies the routing table so that the TAP device
// receives all device traffic. outline-go-tun2socks process TCP and UDP traffic from the TAP
// device and relays it to a Shadowsocks proxy server.
//
// |TAP| <-> |outline-go-tun2socks| <-> |Shadowsocks proxy|
//
// In addition to the basic lifecycle of the helper processes, this class restarts tun2socks
// on unexpected failures and network changes if necessary.
// Follows the Mediator pattern in that none of the "helpers" know anything
// about the others.
export class GoVpnTunnel implements VpnTunnel {
  private readonly tun2socks: GoTun2socks;

  // See #resumeListener.
  private disconnected = false;

  private isUdpEnabled = false;

  private tunnelType: string;

  private readonly onAllHelpersStopped: Promise<void>;
  private resolveAllHelpersStopped: () => void;

  private reconnectingListener?: () => void;

  private reconnectedListener?: () => void;

  constructor(
    private readonly routing: RoutingDaemon,
    private config: ShadowsocksSessionConfig | XraySessionConfig,
    tunnelType: string
  ) {
    this.tun2socks = new GoTun2socks(config, tunnelType);
    this.tunnelType = tunnelType;

    // This promise, tied to both helper process' exits, is key to the instance's
    // lifecycle:
    //  - once any helper fails or exits, stop them all
    //  - once *all* helpers have stopped, we're done
    this.onAllHelpersStopped = new Promise(resolve => {
      this.resolveAllHelpersStopped = resolve;
    });

    // Handle network changes and, on Windows, suspend events.
    this.routing.onNetworkChange = this.networkChanged.bind(this);
  }

  // Turns on verbose logging for the managed processes. Must be called before launching the
  // processes
  enableDebugMode() {
    this.tun2socks.enableDebugMode();
  }

  // Fulfills once all three helpers have started successfully.
  async connect(checkProxyConnectivity: boolean) {
    if (isWindows) {
      // Windows: when the system suspends, tun2socks terminates due to the TAP device getting
      // closed.
      powerMonitor.on('suspend', this.suspendListener.bind(this));
      powerMonitor.on('resume', this.resumeListener.bind(this));
    }

    // Disconnect the tunnel if the routing service disconnects unexpectedly.
    this.routing.onceDisconnected.then(async () => {
      await this.disconnect();
    });

    if (checkProxyConnectivity) {
      this.isUdpEnabled = await checkConnectivity(this.config, this.tunnelType);
    }
    console.log(`UDP support: ${this.isUdpEnabled}`);

    // Don't await here because we want to launch both binaries
    this.tun2socks.startTun2socks(this.isUdpEnabled);
    if (this.tunnelType === 'xray') {
      this.tun2socks.startXray();
    }

    console.log('starting routing daemon');
    await this.routing.start();
  }

  networkChanged(status: TunnelStatus) {
    if (status === TunnelStatus.CONNECTED) {
      if (this.reconnectedListener) {
        this.reconnectedListener();
      }

      // Test whether UDP availability has changed; since it won't change 99% of the time, do this
      // *after* we've informed the client we've reconnected.
      this.updateUdpSupport();
    } else if (status === TunnelStatus.RECONNECTING) {
      if (this.reconnectingListener) {
        this.reconnectingListener();
      }
    } else {
      console.error(`unknown network change status ${status} from routing daemon`);
    }
  }

  private async suspendListener() {
    // Preemptively stop tun2socks to avoid a silent restart that will fail.
    await this.tun2socks.stopTun2socks();
    if (this.tunnelType === 'xray') {
      await this.tun2socks.stopXray();
    }
    console.log('stopped tun2socks in preparation for suspend');
  }

  private resumeListener() {
    if (this.disconnected) {
      // NOTE: Cannot remove resume listeners - Electron bug?
      console.error('resume event invoked but this tunnel is terminated - doing nothing');
      return;
    }

    console.log('restarting tun2socks after resume');
    this.tun2socks.startTun2socks(this.isUdpEnabled);
    if (this.tunnelType === 'xray') {
      this.tun2socks.startXray();
    }

    // Check if UDP support has changed; if so, silently restart.
    this.updateUdpSupport();
  }

  private async updateUdpSupport() {
    const wasUdpEnabled = this.isUdpEnabled;
    try {
      this.isUdpEnabled = await checkConnectivity(this.config, this.tunnelType);
    } catch (e) {
      console.error(`connectivity check failed: ${e}`);
      return;
    }
    if (this.isUdpEnabled === wasUdpEnabled) {
      return;
    }

    console.log(`UDP support change: now ${this.isUdpEnabled}`);

    // Restart tun2socks.
    await this.tun2socks.stopTun2socks();
    if (this.tunnelType === 'xray') {
      await this.tun2socks.stopXray();
    }
    this.tun2socks.startTun2socks(this.isUdpEnabled);
    if (this.tunnelType === 'xray') {
      this.tun2socks.startXray();
    }
  }

  // Use #onceDisconnected to be notified when the tunnel terminates.
  async disconnect() {
    if (this.disconnected) {
      return;
    }

    if (isWindows) {
      powerMonitor.removeListener('suspend', this.suspendListener.bind(this));
      powerMonitor.removeListener('resume', this.resumeListener.bind(this));
    }

    try {
      this.tun2socks.stopTun2socks();
      if (this.tunnelType === 'xray') {
        await this.tun2socks.stopXray();
      }
    } catch (e) {
      if (!(e instanceof ProcessTerminatedSignalError)) {
        console.error(`could not stop tun2socks: ${e.message}`);
      }
    }

    try {
      await this.routing.stop();
    } catch (e) {
      // This can happen for several reasons, e.g. the daemon may have stopped while we were
      // connected.
      console.error(`could not stop routing: ${e.message}`);
    }
    this.resolveAllHelpersStopped();
    this.disconnected = true;
  }

  // Fulfills once all helper processes have stopped.
  //
  // When this happens, *as many changes made to the system in order to establish the full-system
  // VPN as possible* will have been reverted.
  get onceDisconnected() {
    return this.onAllHelpersStopped;
  }

  // Sets an optional callback for when the routing daemon is attempting to re-connect.
  onReconnecting(newListener: () => void | undefined) {
    this.reconnectingListener = newListener;
  }

  // Sets an optional callback for when the routing daemon successfully reconnects.
  onReconnected(newListener: () => void | undefined) {
    this.reconnectedListener = newListener;
  }
}

// outline-go-tun2socks is a Go program that processes IP traffic from a TUN/TAP device
// and relays it to a Shadowsocks proxy server.
class GoTun2socks {
  private stopRequested = false;
  private readonly tun2socksProcess: ChildProcessHelper;
  private readonly xrayProcess: ChildProcessHelper;
  private readonly tunnelType: string;

  constructor(private readonly config: ShadowsocksSessionConfig | XraySessionConfig, tunnelType: string) {
    this.tunnelType = tunnelType;
    this.tun2socksProcess = new ChildProcessHelper(pathToEmbeddedTun2socksBinary(this.tunnelType));
    this.xrayProcess = new ChildProcessHelper(pathToEmbeddedXrayBinary());
  }

  async startTun2socks(isUdpEnabled: boolean): Promise<void> {
    // ./tun2socks.exe \
    //   -tunName outline-tap0 -tunDNS 1.1.1.1,9.9.9.9 \
    //   -tunAddr 10.0.85.2 -tunGw 10.0.85.1 -tunMask 255.255.255.0 \
    //   -proxyHost 127.0.0.1 -proxyPort 1080 -proxyPassword mypassword \
    //   -proxyCipher chacha20-ietf-poly1035
    //   [-dnsFallback] [-checkConnectivity] [-proxyPrefix]
    const args: string[] = [];
    args.push('-tunName', TUN2SOCKS_TAP_DEVICE_NAME);
    args.push('-tunAddr', TUN2SOCKS_TAP_DEVICE_IP);
    args.push('-tunGw', TUN2SOCKS_VIRTUAL_ROUTER_IP);
    args.push('-tunMask', TUN2SOCKS_VIRTUAL_ROUTER_NETMASK);
    
    if (this.tunnelType === 'ss') {      
      args.push('-tunDNS', DNS_RESOLVERS.join(','));
      args.push('-proxyHost', (this.config as ShadowsocksSessionConfig).host || '');
      args.push('-proxyPort', `${(this.config as ShadowsocksSessionConfig).port}`);
      args.push('-proxyPassword', (this.config as ShadowsocksSessionConfig).password || '');
      args.push('-proxyCipher', (this.config as ShadowsocksSessionConfig).method || '');
      args.push('-proxyPrefix', (this.config as ShadowsocksSessionConfig).prefix || '');
      args.push('-logLevel', this.tun2socksProcess.isDebugModeEnabled ? 'debug' : 'info');
    } else if (this.tunnelType === 'xray') {
      args.push('-loglevel', this.tun2socksProcess.isDebugModeEnabled ? 'debug' : 'info');

      const xrayConfig = JSON.parse((this.config as XraySessionConfig).xrayConfig as string);
      args.push('-proxyServer', `${xrayConfig.inbounds[0].listen}:${xrayConfig.inbounds[0].port}`);
    }
    if (!isUdpEnabled) {
      args.push('-dnsFallback');
    }

    this.stopRequested = false;
    let autoRestart = false;
    do {
      if (autoRestart) {
        console.warn(`tun2socks exited unexpectedly. Restarting...`);
      }
      autoRestart = false;
      this.tun2socksProcess.onStdErr = (data?: string | Buffer) => {
        if (data?.toString().includes('tun2socks running')) {
          console.debug('tun2socks started');
          autoRestart = true;
          this.tun2socksProcess.onStdErr = undefined;
        }
      };
      try {
        await this.tun2socksProcess.launch(args);
        console.info('tun2socks exited with no errors');
      } catch (e) {
        console.error(`tun2socks terminated due to ${e}`);
      }
    } while (!this.stopRequested && autoRestart);
  }

  async startXray(): Promise<void> {
    // ./xray.exe \
    this.stopRequested = false;
    let autoRestart = false;
    do {
      if (autoRestart) {
        console.warn(`xray exited unexpectedly. Restarting...`);
      }
      autoRestart = false;
      this.xrayProcess.onStdErr = (data?: string | Buffer) => {
        if (data?.toString().includes('xray running')) {
          console.debug('xray started');
          autoRestart = true;
          this.xrayProcess.onStdErr = undefined;
        }
      };
      this.saveXrayConfigToJsonFile(JSON.stringify(this.config), pathToXrayConfigJson())
      try {
        await this.xrayProcess.launch([]);
        console.info('xray exited with no errors');
      } catch (e) {
        console.error(`xray terminated due to ${e}`);
      }
    } while (!this.stopRequested && autoRestart);
  }

  saveXrayConfigToJsonFile(jsonString: string, filePath: string) {
    const jsonObject = JSON.parse(jsonString);
    if (!jsonObject.xrayConfig) {
      return;
    } else {
      try {
        const jsonFormattedString = JSON.stringify(JSON.parse(jsonObject.xrayConfig), null, 2);
        fs.writeFileSync(filePath, jsonFormattedString, 'utf8');
      } catch (e) {
        console.error(`failed to save xray config to file: ${e}`);
      }
    }
  }

  stopTun2socks() {
    this.stopRequested = true;
    return this.tun2socksProcess.stop();
  }

  stopXray() {
    return this.xrayProcess.stop();
  }

  /**
   * Checks connectivity and exits with an error code as defined in `errors.ErrorCode`.
   * If exit code is not zero, a `ProcessTerminatedExitCodeError` might be thrown.
   * -tun* and -dnsFallback options have no effect on this mode.
   */
  checkConnectivity() {
    console.debug('using tun2socks to check connectivity');
    if (this.tunnelType === 'ss') {
      return this.tun2socksProcess.launch([
        '-proxyHost',
        (this.config as ShadowsocksSessionConfig).host || '',
        '-proxyPort',
        `${(this.config as ShadowsocksSessionConfig).port}`,
        '-proxyPassword',
        (this.config as ShadowsocksSessionConfig).password || '',
        '-proxyCipher',
        (this.config as ShadowsocksSessionConfig).method || '',
        '-proxyPrefix',
        (this.config as ShadowsocksSessionConfig).prefix || '',
        '-checkConnectivity',
      ]);
    } else if (this.tunnelType === 'xray') {
      return true;
    }
  }

  enableDebugMode() {
    this.tun2socksProcess.isDebugModeEnabled = true;
  }
}

// Leverages the outline-go-tun2socks binary to check connectivity to the server specified in
// `config`. Checks whether proxy server is reachable, whether the network and proxy support UDP
// forwarding and validates the proxy credentials. Resolves with a boolean indicating whether UDP
// forwarding is supported. Throws if the checks fail or if the process fails to start.
async function checkConnectivity(config: ShadowsocksSessionConfig | XraySessionConfig, tunnelType: string) {
  try {
    await new GoTun2socks(config, tunnelType).checkConnectivity();
    return true;
  } catch (e) {
    console.error(`connectivity check error: ${e}`);
    if (e instanceof ProcessTerminatedExitCodeError) {
      if (e.exitCode === ErrorCode.UDP_RELAY_NOT_ENABLED) {
        return false;
      }
      throw fromErrorCode(e.exitCode);
    }
    throw new UnexpectedPluginError();
  }
}
