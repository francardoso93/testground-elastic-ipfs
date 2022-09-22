# Readme

- `kubo-client` plan is the only one currently working (through `local:exec` runner). It is capable of connecting to EIPFS and retrieve a file.
- `js-ipfs-client` doesn't have outbound internal access (thorugh `local:docker` runner). Testground SDK currently doesn't provide a way of overriding this behaviour.
- `libp2p-client` didn't work and it's here for historical purposes only.

## Running kubo-client

```sh
testground plan import --from plans/kubo-client
```

``` sh
testground run single --plan kubo-client  \
                      --testcase kubo \
                      --builder exec:go \
                      --runner local:exec \
                      --instances 1
```

## Running js-ipfs-client

```sh
testground plan import --from plans/js-ipfs-client
```

``` sh 
testground run single --plan js-ipfs-client \            
                      --testcase bitswap \
                      --builder docker:node \
                      --runner local:docker \
                      --instances 1 --test-param multiaddr=$MULTIADDR
```

Learn more about Testground in [official docs](https://docs.testground.ai/).
