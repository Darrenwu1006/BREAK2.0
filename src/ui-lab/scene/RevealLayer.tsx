// M9a CP5c 判定揭示層：P0 我方 DP/OP 以 3D Text 平貼桌面（同「發球區」文字風格）；
// P1 對稱到對方場地並旋轉 180°。judge 結果保留 Html 做大字橫幅。
// 節奏由 usePlayback 的 reveal 狀態驅動（op→dp→judge 三拍，turn 邊界清空）——本檔只管長相。

import { Html } from "@react-three/drei";
import type { RevealView } from "../game/usePlayback";
import styles from "../UiLabApp.module.css";

// 攔網列左右外側錨點
// blockSide x = ±1.9, SLOT_W/2 = 0.61 → 邊緣 = ±2.51；再外留間距
const BLOCK_Z = 1.15;
const CHIP_Y = 0.12; // 略浮起，Html 平視籌碼

// P0 位置：DP 左側、OP 右側
const P0_DP_X = -3.3;
const P0_OP_X = 3.3;

/** 單枚 OP/DP 籌碼：[使用者 2026-07-12] #2 改 Html/CSS（好調樣式）——標籤小、數字大、無外框。 */
function Chip3D(props: {
  x: number;
  z: number;
  player: 0 | 1;
  label: string;
  value: number;
  color: string;
  bgColor: string;
}): React.JSX.Element {
  return (
    <Html position={[props.x, CHIP_Y, props.z]} center style={{ pointerEvents: "none" }} zIndexRange={[3, 0]}>
      <div className={styles.revealChip} style={{ background: props.bgColor, color: props.color }}>
        <span className={styles.revealChipLabel}>{props.label}</span>
        <strong className={styles.revealChipValue}>{props.value}</strong>
      </div>
    </Html>
  );
}

/** 判定揭示層 */
export function RevealLayer(props: { reveal: RevealView; showJudge?: boolean }): React.JSX.Element {
  const { op, dp, judge } = props.reveal;
  const showJudge = props.showJudge ?? true;

  const opPlayer = (op?.player ?? 0) as 0 | 1;
  const dpPlayer = (dp?.player ?? 0) as 0 | 1;

  // OP 及 DP 的 x 座標：P0 用近側固定位置，P1 用對稱位置（x 取負）
  const opX = opPlayer === 0 ? P0_OP_X : -P0_OP_X;
  const dpX = dpPlayer === 0 ? P0_DP_X : -P0_DP_X;
  // Z 軸：P0 近側正數，P1 遠側負數
  const opZ = opPlayer === 0 ? BLOCK_Z : -BLOCK_Z;
  const dpZ = dpPlayer === 0 ? BLOCK_Z : -BLOCK_Z;

  return (
    <group>
      {op && (
        <Chip3D
          x={opX} z={opZ}
          player={opPlayer}
          label="OP"
          value={op.value}
          color="#ffe0a0"
          bgColor="#5a3800"
        />
      )}
      {dp && (
        <Chip3D
          x={dpX} z={dpZ}
          player={dpPlayer}
          label="DP"
          value={dp.value}
          color="#a0d8ff"
          bgColor="#003258"
        />
      )}
      {judge && showJudge && (
        <Html position={[0, 0.05, -6.6]} center style={{ pointerEvents: "none" }}>
          <div className={judge.success ? styles.judgeHold : styles.judgeBreak}>
            {judge.success ? (judge.defense === "block" ? "攔網成功！" : "接球成功！") : "突破！！"}
          </div>
        </Html>
      )}
    </group>
  );
}
