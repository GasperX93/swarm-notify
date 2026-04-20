import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-ethers'

const config: HardhatUserConfig = {
  solidity: '0.8.24',
  paths: {
    sources: './contracts',
    artifacts: './artifacts',
    cache: './cache',
  },
  networks: {
    gnosis: {
      url: process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    chiado: {
      url: process.env.CHIADO_RPC_URL || 'https://rpc.chiadochain.net',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
}

export default config
