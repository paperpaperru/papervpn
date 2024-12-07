package xrayMobile

import (
	"errors"
	"github.com/Jigsaw-Code/outline-client/src/tun2socks/tunnel"
	"github.com/eycorsican/go-tun2socks/core"
	"github.com/eycorsican/go-tun2socks/proxy/socks"
	"io"
	"time"
)

type Tunnel interface {
	tunnel.Tunnel
}

type localSocksTunnel struct {
	tunnel.Tunnel
}

func (t *localSocksTunnel) UpdateUDPSupport() bool {
	return true
}

func newTunnel(tunWriter io.WriteCloser) (tunnel.Tunnel, error) {
	if tunWriter == nil {
		return nil, errors.New("Must provide a TUN writer")
	}
	core.RegisterOutputFn(func(data []byte) (int, error) {
		return tunWriter.Write(data)
	})
	lwipStack := core.NewLWIPStack()
	core.RegisterTCPConnHandler(socks.NewTCPHandler("127.0.0.1", 12080))
	core.RegisterUDPConnHandler(socks.NewUDPHandler("127.0.0.1", 12080, 30*time.Second))

	// Copy packets from tun device to lwip stack, it's the main loop.

	return tunnel.NewTunnel(tunWriter, lwipStack), nil
}
