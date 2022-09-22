# Readme

- `kubo-client` plan is the only one currently working (through `local:exec` runner). It is capable of connecting to EIPFS and retrieve a file.
- `js-ipfs-client` doesn't have outbound internal access (thorugh `local:docker` runner). Testground SDK currently doesn't provide a way of overriding this behaviour.
- `libp2p-client` didn't work and it's here for historical purposes only.
