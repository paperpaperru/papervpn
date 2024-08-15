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

import {SHADOWSOCKS_URI} from 'ShadowsocksConfig';

import * as errors from '../../model/errors';

import {ShadowsocksSessionConfig, XraySessionConfig} from '../tunnel';

// DON'T use these methods outside of this folder!

// Parses an access key string into a ShadowsocksConfig object.
export function staticKeyToShadowsocksSessionConfig(staticKey: string): ShadowsocksSessionConfig {
  try {
    const config = SHADOWSOCKS_URI.parse(staticKey);
    return {
      host: config.host.data,
      port: config.port.data,
      method: config.method.data,
      password: config.password.data,
      prefix: config.extra?.['prefix'],
    };
  } catch (cause) {
    throw new errors.ServerAccessKeyInvalid('Invalid static access key.', {cause});
  }
}

interface ShadowsocksServerConfig {
  method: string,
  password: string,
  server: string,
  server_port: number,
  prefix: string
}

function parseShadowsocksSessionConfigJson(responseJson: ShadowsocksServerConfig): ShadowsocksSessionConfig | null {
  const {method, password, server, server_port, prefix} = responseJson;

  // These are the mandatory keys.
  const missingKeys = [];

  for (const [key, value] of Object.entries({method, password, server, server_port})) {
    if (typeof value === 'undefined') {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    throw new TypeError(`Missing JSON fields: ${missingKeys.join(', ')}.`);
  }

  return {
    method,
    password,
    host: server,
    port: server_port,
    prefix,
  };
}

interface VlessNode {
  address: string
}
interface Settings {
  vnext: VlessNode[]
}
interface Outbound {
  settings: Settings
}
interface Inbound {
  host: string,
  port: number
}
interface XrayServerConfig {
  outbounds: Outbound[],
  inbounds: Inbound[]
}

function parseXraySessionConfigJson(responseJson: XrayServerConfig): XraySessionConfig | null {
  const host: string = responseJson.outbounds[0].settings.vnext[0].address;
  responseJson.inbounds[0].port = 12080

  return {
    xrayConfig: JSON.stringify(responseJson),
    host: host,
  }
}

// fetches information from a dynamic access key and attempts to parse it
// TODO(daniellacosse): unit tests
export async function fetchSessionConfig(configLocation: URL): Promise<ShadowsocksSessionConfig|XraySessionConfig> {
  const fixedConfigLocation = configLocation.toString().replace('^xray:', 'https:');
  configLocation = new URL(fixedConfigLocation);
  configLocation.searchParams.append('type', '1')
  const options: any = {
    cache: 'no-store',
    redirect: 'follow',
    //headers: {'Accept': 'application/json'},
  };
  let response;
  try {
    response = await fetch(configLocation, options);
  } catch (cause) {
    throw new errors.SessionConfigFetchFailed('Failed to fetch VPN information from dynamic access key.', {cause});
  }

  const responseBody = (await response.text()).trim();

  try {
    if (responseBody.startsWith('ss://')) {
      return staticKeyToShadowsocksSessionConfig(responseBody);
    }
    else {
      const responseJson = JSON.parse(responseBody);

      if ('error' in responseJson) {
        throw new errors.SessionConfigError(responseJson.error.message);
      }

      if ( 'method' in responseJson ) {
        return parseShadowsocksSessionConfigJson(responseJson);
      }
      else {
        return parseXraySessionConfigJson(responseJson);
      }
    }

  } catch (cause) {
    if (cause instanceof errors.SessionConfigError) {
      throw cause;
    }

    throw new errors.ServerAccessKeyInvalid('Failed to parse VPN information fetched from dynamic access key.', {
      cause,
    });
  }
}