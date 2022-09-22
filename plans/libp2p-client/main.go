package main

import (
	"github.com/testground/sdk-go/run"
	"github.com/testground/sdk-go/runtime"
)

func main() {
	run.InvokeMap(map[string]interface{}{
		"libp2p":     startLibp2p,
		"smallbrain": execute,
		"bigbrain":   execute,
	})
}

func execute(runenv *runtime.RunEnv) error {
	var (
		num     = runenv.IntParam("num")
		word    = runenv.StringParam("word")
		feature = runenv.BooleanParam("feature")
	)

	runenv.RecordMessage("I am a %s test case.", runenv.TestCase)
	runenv.RecordMessage("I store my files on %d servers.", num)
	runenv.RecordMessage("I %s run tests on my P2P code.", word)

	if feature {
		runenv.RecordMessage("I use IPFS!")
	}

	return nil
}

