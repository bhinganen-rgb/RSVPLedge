require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    hardhat: {},
    botchain_testnet: {
      url: "https://rpc.bohr.life",
      chainId: 968,
      accounts: PK
    },
    botchain: {
      url: "https://rpc.botchain.ai",
      chainId: 677,
      accounts: PK
    }
  }
};
