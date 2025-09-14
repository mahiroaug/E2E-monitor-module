import * as dotenv from "dotenv";
import { resolve } from "path";
import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@fireblocks/hardhat-fireblocks";
import "@nomicfoundation/hardhat-ignition";
import "@typechain/hardhat";
import * as fs from "fs";

dotenv.config({ path: resolve(__dirname, "../../.env") });
let fb_apiSecret: string = "";
try {
  if (process.env.FIREBLOCKS_SECRET_KEY_FILE) {
    const p = resolve(`../../${process.env.FIREBLOCKS_SECRET_KEY_FILE}`);
    if (fs.existsSync(p)) {
      fb_apiSecret = fs.readFileSync(p, "utf8");
    }
  }
} catch (e) {
  fb_apiSecret = "";
}

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
    hardhat: {
      chainId: 1337
    },
    localhost: {
      url: "http://127.0.0.1:8545"
    },
    amoy: {
      url: "https://rpc-amoy.polygon.technology",
      fireblocks: {
        apiKey: process.env.FIREBLOCKS_API_KEY || "",
        privateKey: fb_apiSecret,
        vaultAccountIds: process.env.FIREBLOCKS_VID_DEPLOYER || "",
      },
    },
    polygon: {
      url: "https://polygon-rpc.com",
      fireblocks: {
        apiKey: process.env.FIREBLOCKS_API_KEY || "",
        privateKey: fb_apiSecret,
        vaultAccountIds: process.env.FIREBLOCKS_VID_DEPLOYER || "",
      },
    },
  },
  etherscan: {
    apiKey: {
      polygon: process.env.POLYGONSCAN_API_KEY || "",
      amoy: process.env.POLYGONSCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "amoy",
        chainId: 80002,
        urls: {
          apiURL: "https://api-amoy.polygonscan.com/api",
          browserURL: "https://amoy.polygonscan.com",
        },
      },
    ],
  },
  sourcify: {
    enabled: true
  }
};

export default config;
