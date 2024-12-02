// Copyright 2018 The Outline Authors
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

/// <reference types='cordova'/>
/// <reference path='../types/webintents.d.ts'/>

import '@babel/polyfill';
import 'web-animations-js/web-animations-next-lite.min.js';
import '@webcomponents/webcomponentsjs/webcomponents-bundle.js';

import {setRootPath} from '@polymer/polymer/lib/utils/settings.js';
setRootPath(location.pathname.substring(0, location.pathname.lastIndexOf('/') + 1));

import * as Sentry from '@sentry/browser';

import {AbstractClipboard} from './clipboard';
import {EnvironmentVariables} from './environment';
import {main} from './main';
import * as errors from '../model/errors';
import {OutlinePlatform} from './platform';
import {Tunnel, TunnelStatus} from './tunnel';
import {AbstractUpdater} from './updater';
import * as interceptors from './url_interceptor';
import {FakeOutlineTunnel} from './fake_tunnel';
import {ShadowsocksSessionConfig} from './tunnel';
import {NoOpVpnInstaller, VpnInstaller} from './vpn_installer';

const OUTLINE_PLUGIN_NAME = 'OutlinePlugin';

// Pushes a clipboard event whenever the app is brought to the foreground.
class CordovaClipboard extends AbstractClipboard {
  getContents() {
    return new Promise<string>((resolve, reject) => {
      cordova.plugins.clipboard.paste(resolve, reject);
    });
  }
}

// Helper function to call the Outline Cordova plugin.
function pluginExec<T>(cmd: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    cordova.exec(resolve, reject, OUTLINE_PLUGIN_NAME, cmd, args);
  });
}

async function pluginExecWithErrorCode<T>(cmd: string, ...args: unknown[]): Promise<T> {
  try {
    return await pluginExec<T>(cmd, ...args);
  } catch (errorCode) {
    throw errors.fromErrorCode(errorCode);
  }
}

class CordovaTunnel implements Tunnel {
  constructor(public id: string) {}

  start(config: ShadowsocksSessionConfig) {
    if (!config) {
      throw new errors.IllegalServerConfiguration();
    }
    return pluginExecWithErrorCode<void>('start', this.id, config);
  }

  stop() {
    return pluginExecWithErrorCode<void>('stop', this.id);
  }

  isRunning() {
    return pluginExecWithErrorCode<boolean>('isRunning', this.id);
  }

  onStatusChange(listener: (status: TunnelStatus) => void): void {
    const onError = (err: unknown) => {
      console.warn('failed to execute status change listener', err);
    };
    // Can't use `pluginExec` because Cordova needs to call the listener multiple times.
    cordova.exec(listener, onError, OUTLINE_PLUGIN_NAME, 'onStatusChange', [this.id]);
  }
}

// This class should only be instantiated after Cordova fires the deviceready event.
class CordovaPlatform implements OutlinePlatform {
  private static isBrowser() {
    return cordova.platformId === 'browser';
  }

  hasDeviceSupport() {
    return !CordovaPlatform.isBrowser();
  }

  getTunnelFactory() {
    return (id: string) => {
      return this.hasDeviceSupport() ? new CordovaTunnel(id) : new FakeOutlineTunnel(id);
    };
  }

  getUrlInterceptor() {
    if (cordova.platformId === 'ios' || cordova.platformId === 'osx') {
      return new interceptors.AppleUrlInterceptor(appleLaunchUrl);
    } else if (cordova.platformId === 'android') {
      return new interceptors.AndroidUrlInterceptor();
    }
    console.warn('no intent interceptor available');
    return new interceptors.UrlInterceptor();
  }

  getClipboard() {
    return new CordovaClipboard();
  }

  getUpdater() {
    return new AbstractUpdater();
  }

  getVpnServiceInstaller(): VpnInstaller {
    return new NoOpVpnInstaller();
  }

  quitApplication() {
    // Only used in macOS because menu bar apps provide no alternative way of quitting.
    cordova.exec(
      () => {},
      () => {},
      OUTLINE_PLUGIN_NAME,
      'quitApplication',
      []
    );
  }
}

// https://cordova.apache.org/docs/en/latest/cordova/events/events.html#deviceready
const onceDeviceReady = new Promise(resolve => {
  document.addEventListener('deviceready', resolve);
});

// cordova-[ios|osx] call a global function with this signature when a URL is
// intercepted. We handle URL interceptions with an intent interceptor; however,
// when the app is launched via URL our start up sequence misses the call due to
// a race. Define the function temporarily here, and set a global variable.
let appleLaunchUrl: string;
window.handleOpenURL = (url: string) => {
  appleLaunchUrl = url;
};

onceDeviceReady.then(() => {
  main(new CordovaPlatform());
});
