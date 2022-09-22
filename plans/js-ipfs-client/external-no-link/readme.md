I had to copy files/folders of [bitswap peer]((https://github.com/elastic-ipfs/bitswap-peer) that are coupled to this context:
- src
- playgrounds/bitswap-client.js
- .npmrc
- bitswap.proto

This could be better if:
https://github.com/testground/testground/issues/1466

Then:
We could get rid of symlinks and create a `Dockerfile.testground` at root lvl in [bitswap peer](https://github.com/elastic-ipfs/bitswap-peer)

But:
https://github.com/testground/testground/blob/eaab2784579967f0cab559242a7124c161243273/pkg/build/docker_generic.go#L65
