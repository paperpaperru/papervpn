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

import * as errors from '../../model/errors';
import {ServerType} from '../../model/server';

import {Tunnel, XraySessionConfig} from '../tunnel';

import {fetchXraySessionConfig, staticKeyToShadowsocksSessionConfig} from './access_key_serialization';
import {OutlineServer} from "./server";
import * as events from "../../model/events";

// PLEASE DON'T use this class outside of this `outline_server_repository` folder!

export class XrayOutlineServer extends OutlineServer {
  // We restrict to AEAD ciphers because unsafe ciphers are not supported in go-tun2socks.
  // https://shadowsocks.org/en/spec/AEAD-Ciphers.html
  errorMessageId?: string;
  private sessionConfig?: XraySessionConfig;

  constructor(
      id: string,
      public readonly accessKey: string,
      type: ServerType,
      _name: string,
      tunnel: Tunnel,
      eventQueue: events.EventQueue
  ) {
    super(id, type, _name, tunnel, eventQueue)
    switch (this.type) {
      case ServerType.DYNAMIC_CONNECTION:
        this.accessKey = accessKey.replace(/^ssconf:\/\//, 'https://');
        break;
      case ServerType.STATIC_CONNECTION:
      default:
        this.sessionConfig = staticKeyToShadowsocksSessionConfig(accessKey);
        break;
    }
  }

  get address() {
    if (!this.sessionConfig) return '';

    return `${this.sessionConfig.host}`;
  }

  get sessionConfigLocation() {
    if (this.type !== ServerType.DYNAMIC_CONNECTION) {
      return;
    }

    return new URL(this.accessKey);
  }

  get isOutlineServer() {
    return false
  }

  async connect() {
      this.sessionConfig = await fetchXraySessionConfig(this.sessionConfigLocation);
      try {
        await this.tunnel.start(this.sessionConfig, true);
      } catch (cause) {
      // e originates in "native" code: either Cordova or Electron's main process.
      // Because of this, we cannot assume "instanceof OutlinePluginError" will work.
      if (cause.errorCode) {
        throw errors.fromErrorCode(cause.errorCode);
      }

      throw new errors.ProxyConnectionFailure(`Failed to connect to server ${this.name}.`, {cause});
    }
  }

  async disconnect() {
    try {
      await this.tunnel.stop();

      if (this.type === ServerType.DYNAMIC_CONNECTION) {
        this.sessionConfig = undefined;
      }
    } catch (e) {
      // All the plugins treat disconnection errors as ErrorCode.UNEXPECTED.
      throw new errors.RegularNativeError();
    }
  }
}
