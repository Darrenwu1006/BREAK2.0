// M9a CP4 判定揭示層：OP/DP 數字錨在 3D 區域上方彈出（drei Html），判定結果打在網子正上方。
// 節奏由 usePlayback 的 reveal 狀態驅動（op→dp→judge 三拍，turn 邊界清空）——本檔只管長相。

import { Html } from "@react-three/drei";
import type { RevealView } from "../game/usePlayback";
import type { ZoneId } from "../presentation/events";
import styles from "../UiLabApp.module.css";
import { zoneAnchor } from "./layout";

const OP_ZONE: Record<"serve" | "block" | "attack", ZoneId> = { serve: "serve", block: "blockCenter", attack: "attack" };
const DP_ZONE: Record<"block" | "receive", ZoneId> = { block: "blockCenter", receive: "receive" };

export function RevealLayer(props: { reveal: RevealView }): React.JSX.Element {
  const { op, dp, judge } = props.reveal;
  const opA = op ? zoneAnchor(op.player, OP_ZONE[op.source]) : null;
  const dpA = dp ? zoneAnchor(dp.player, DP_ZONE[dp.source]) : null;
  return (
    <group>
      {op && opA && (
        <Html position={[opA.x, 1.35, opA.z]} center style={{ pointerEvents: "none" }}>
          <div className={`${styles.chip} ${styles.chipOp}`}>OP {op.value}</div>
        </Html>
      )}
      {dp && dpA && (
        <Html position={[dpA.x, 1.35, dpA.z]} center style={{ pointerEvents: "none" }}>
          <div className={`${styles.chip} ${styles.chipDp}`}>DP {dp.value}</div>
        </Html>
      )}
      {judge && (
        <Html position={[0, 2.3, 0]} center style={{ pointerEvents: "none" }}>
          <div className={judge.success ? styles.judgeHold : styles.judgeBreak}>
            {judge.success ? (judge.defense === "block" ? "ブロック成功！" : "レシーブ成功！") : "突破！！"}
          </div>
        </Html>
      )}
    </group>
  );
}
