package main

import (
	"github.com/testground/sdk-go/run"
	"github.com/testground/sdk-go/runtime"
)

func main() {
	run.InvokeMap(map[string]interface{}{
		"kubo":  run.InitializedTestCaseFn(startKubo),
	})
}

func startKubo(runenv *runtime.RunEnv, initCtx *run.InitContext) error {
	requestBlocks() // TODO: Params: Multiaddr and CIDs file
	return nil
}
