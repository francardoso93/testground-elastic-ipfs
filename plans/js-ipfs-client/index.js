const { invokeMap, network, runtime } = require('@testground/sdk')
const {
  client: bitswapClient,
} = require('./external-no-link/playgrounds/bitswap-client.js')
const axios = require('axios')
const https = require('https')

const testcases = {
  bitswap,
  http,
}

;(async () => {
  // This is the plan entry point.
  await invokeMap(testcases)
})()

async function bitswap(runenv) {
  const multiaddr = runenv.runParams.testInstanceParams.multiaddr
  const cidsfile = runenv.runParams.testInstanceParams.cidsfile
  await bitswapClient(multiaddr, cidsfile)
}

// This is just for checking  parameter object properties and outbound internet access
async function http(runenv, context) {
  console.log('******')
  console.log(runenv)
  console.log('**********************')
  console.log(context)

  // const agent = new https.Agent({
  //   rejectUnauthorized: false
  // });
  // axios
  // .get('https://google.com', { httpsAgent: agent })
  // .then(res => {
  //   console.log(`statusCode: ${res.status}`);
  //   console.log(res);
  // })
  // .catch(error => {
  //   console.error(error);
  // });
}

