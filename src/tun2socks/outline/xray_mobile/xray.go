package xrayMobile

import (
	"fmt"
	"log"
	"os"
	"runtime/debug"
	"time"

	"github.com/xtls/xray-core/common/cmdarg"
	"github.com/xtls/xray-core/core"
	_ "github.com/xtls/xray-core/main/distro/all"
)

var (
	coreServer *core.Instance
)

func forceFree(interval time.Duration) {
	go func() {
		for {
			time.Sleep(interval)
			debug.FreeOSMemory()
		}
	}()
}

func initForceFree(maxMemory int64, interval int) {
	debug.SetGCPercent(10)
	debug.SetMemoryLimit(maxMemory)
	if interval > 0 {
		duration := time.Duration(interval) * time.Second
		forceFree(duration)
	}
}

func RunXray(datDir string, configPath string, maxMemory int64) (err error) {
	err = os.Setenv("xray.location.asset", datDir)
	if err != nil {
		return err
	}

	if maxMemory > 0 {
		initForceFree(maxMemory, 1)
	}

	coreServer, err = startXray(configPath)
	if err != nil {
		return err
	}
	if err = coreServer.Start(); err != nil {
		return fmt.Errorf("coreServer.Start() failed: %w", err)
	}

	debug.FreeOSMemory()
	return nil
}

func startXray(configPath string) (*core.Instance, error) {
	file := cmdarg.Arg{configPath}
	config, err := core.LoadConfig("json", file)
	if err != nil {
		return nil, err
	}
	server, err := core.New(config)
	if err != nil {
		return nil, err
	}
	return server, nil
}

func stopXray() error {
	if coreServer != nil {
		err := coreServer.Close()
		coreServer = nil
		if err != nil {
			return err
		}
	}
	return nil
}

func StartXrayServer(configDir string, config string) string {
	log.Printf("StartXrayServer")
	//geo := libXray.LoadGeoData(configDir)
	configFile := configDir + "/config.json"
	e := os.WriteFile(configFile, []byte(config), 0644)
	if e != nil {
		return fmt.Sprintf("writeConfig %s failed %s", configFile, e.Error())
	}
	log.Printf("writeConfig done %s", configFile)
	s := RunXray(configDir, configFile, 13*1000*1000)
	if s != nil {
		return s.Error()
	} else {
		return "ok"
	}
}

func StopXrayServer() string {
	e := stopXray()
	if e != nil {
		return e.Error()
	} else {
		return "ok"
	}
}
