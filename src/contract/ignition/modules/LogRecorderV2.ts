import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("LogRecorderV2Module", m => {
  // LogRecorderV2コントラクトをデプロイ
  const logRecorderV2 = m.contract("LogRecorderV2");

  return {
    logRecorderV2,
  };
}); 