import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("E2eMonitorModule", (m) => {
  // 初期送信者（SENDER_ROLE 付与先）
  const initialSender = m.getParameter<string>("initialSender", "0x0000000000000000000000000000000000000000");

  const e2eMonitor = m.contract("E2eMonitor", [initialSender]);

  return { e2eMonitor };
});


