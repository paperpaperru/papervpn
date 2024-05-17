package xrayMobile

import (
	"fmt"
	"github.com/xtls/libxray"
	"log"
	"os"
)

func writeConfig(configFile string, host string, port int, uuid string) error {
	config := []byte(fmt.Sprintf(`
{
  "log": {
    "loglevel": "debug",
    "dnsLog": true
  },
  "inbounds": [
    {
      "port": 12080,
      "listen": "127.0.0.1",
      "protocol": "socks",
      "settings": {
        "udp": true
      }
    }
  ],
  "outbounds": [
    {
      "protocol": "vless",
      "settings": {
        "vnext": [
          {
            "address": "%s",
            "port": %d,
            "users": [
              {
                "id": "%s",
                "encryption": "none"
              }
            ]
          }
        ]
      },
      "streamSettings": {
        "network": "quic",
        "security": "tls",
        "quicSettings": {},
        "tlsSettings": {
          "serverName": "service-ru.cn.cybertechpinas.org",
          "fingerprint": "chrome",
          "alpn": [
            "h2",
            "http/1.1"
          ]
        }
      }
    }
  ]
}`, host, port, uuid))
	return os.WriteFile(configFile, config, 0644)
}

func StartXrayServer(configDir string, host string, port int, uuid string) string {
	geo := libXray.LoadGeoData(configDir)
	configFile := configDir + "config.json"
	e := writeConfig(configFile, host, port, uuid)
	if e != nil {
		return fmt.Sprintf("writeConfig %s failed %s", configFile, e.Error())
	}
	fmt.Println("writeConfig done")
	s := libXray.RunXray(configDir, configFile, 13*1000*1000)
	log.Print("RunXray called")
	return s + geo
}

func StopXrayServer() string {
	return libXray.StopXray()
}
