import { expect } from "chai";
import "@nomicfoundation/hardhat-ethers"; // 型拡張を読み込み
import { ethers } from "hardhat";        // named import を有効化
import "@nomicfoundation/hardhat-chai-matchers"; // chai の型拡張（.emit など）を有効化


describe("E2eMonitor", function () {
  it("emits E2ePing with all fields", async function () {
    const [deployer, sender] = await ethers.getSigners();
    const E2eMonitor = await ethers.getContractFactory("E2eMonitor");
    const c = await E2eMonitor.deploy(sender.address);
    await c.waitForDeployment();

    const correlationId = ethers.id("test-correlation"); // bytes32
    const tag = ethers.id("tag");
    const clientTimestamp = Math.floor(Date.now() / 1000);
    const nonce = await ethers.provider.getTransactionCount(sender.address);

    const tx = await c.connect(sender).ping(correlationId, tag, clientTimestamp, nonce);
    const rc = await tx.wait();
    const events = await c.queryFilter(c.filters.E2ePing(correlationId, sender.address), rc!.blockNumber, rc!.blockNumber);
    expect(events.length).to.equal(1);
    const args = events[0].args as unknown as { correlationId: string; sender: string; clientTimestamp: bigint; nonce: bigint; blockTimestamp: bigint; tag: string };
    expect(args.correlationId).to.equal(correlationId);
    expect(args.sender).to.equal(sender.address);
    expect(Number(args.clientTimestamp)).to.equal(clientTimestamp);
    expect(Number(args.nonce)).to.equal(nonce);
    expect(args.tag).to.equal(tag);
  });
});


