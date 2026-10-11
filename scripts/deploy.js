const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(bal), "BOT");

  const F = await hre.ethers.getContractFactory("RSVPledge");
  const c = await F.deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("RSVPledge deployed at:", addr);
  console.log("Network:", hre.network.name);
  console.log("\nNext: Update CONTRACT_ADDRESS in frontend/index.html to:", addr);
}

main().catch((e) => { console.error(e); process.exit(1); });
