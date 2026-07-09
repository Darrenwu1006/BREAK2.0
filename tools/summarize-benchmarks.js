import { readFileSync } from "node:fs";

const opponents = [
  { name: "梟谷-第三彈官方", key: "fukurodani" },
  { name: "音駒-音駒-二口干擾", key: "nekoma_disturb" },
  { name: "音駒-音駒-三彈官方", key: "nekoma_official" },
  { name: "白鳥沢-三彈優化", key: "shiratorizawa" },
  { name: "伊達工業-攔網軸改_韋宏", key: "date_tech" }
];

const versions = [
  { name: "0張版", prefix: "bench_0" },
  { name: "1張版", prefix: "bench_1" },
  { name: "2張版", prefix: "bench_2" },
  { name: "3張版", prefix: "bench_3" }
];

console.log("| 牌組版本 | 對手 | 勝率 | Set取得率 | 未能登場比例 |");
console.log("| :--- | :--- | :---: | :---: | :---: |");

const summaryData = {};

for (const ver of versions) {
  summaryData[ver.name] = { totalWins: 0, totalGames: 0, totalSets: 0, totalSetWins: 0, opponentStats: {} };
  
  for (const opp of opponents) {
    const filePath = `reports/optimizer/${ver.prefix}_${opp.key}.json`;
    try {
      const content = JSON.parse(readFileSync(filePath, "utf8"));
      // JSON structure is { summary: { winsByPlayer: [p0Wins, p1Wins], total: N, ... } }
      // In batch report, the root has "summary"
      const report = content.report;
      const summary = report.summary;
      const completed = summary.completed;
      const wins = summary.winsByPlayer[0];
      const winRate = completed > 0 ? (wins / completed * 100).toFixed(1) + "%" : "0%";
      
      // Let's also look at Set win rate and lost reasons
      const setWinsP0 = summary.setWinsByPlayer[0] || 0;
      const setWinsP1 = summary.setWinsByPlayer[1] || 0;
      const totalSets = setWinsP0 + setWinsP1;
      const setWinRate = totalSets > 0 ? (setWinsP0 / totalSets * 100).toFixed(1) + "%" : "0%";
      
      const p0NoDeploy = (summary.playQualityByPlayer && summary.playQualityByPlayer[0] && summary.playQualityByPlayer[0].noDeployLossRate) || 0;
      const lostReasons = summary.lostReasons || {};
      const totalLost = Object.values(lostReasons).reduce((a, b) => a + b, 0);
      const noDeployCount = lostReasons["no-deploy"] || 0;
      const noDeployRate = totalLost > 0 ? (noDeployCount / totalLost * 100).toFixed(1) + "%" : "0%";
      
      summaryData[ver.name].totalWins += wins;
      summaryData[ver.name].totalGames += completed;
      summaryData[ver.name].totalSetWins += setWinsP0;
      summaryData[ver.name].totalSets += totalSets;
      
      summaryData[ver.name].opponentStats[opp.name] = {
        winRate,
        setWinRate,
        noDeployRate,
        rawWins: wins,
        rawCompleted: completed
      };
      
      console.log(`| ${ver.name} | ${opp.name} | ${winRate} (${wins}/${completed}) | ${setWinRate} | ${noDeployRate} |`);
    } catch (e) {
      console.error(`Error reading ${filePath}:`, e.message);
    }
  }
}

console.log("\n=== 宏觀對比 ===");
for (const ver of versions) {
  const data = summaryData[ver.name];
  const overallWinRate = data.totalGames > 0 ? (data.totalWins / data.totalGames * 100).toFixed(1) + "%" : "0%";
  const overallSetWinRate = data.totalSets > 0 ? (data.totalSetWins / data.totalSets * 100).toFixed(1) + "%" : "0%";
  console.log(`- ${ver.name}: 整體勝率 ${overallWinRate} (${data.totalWins}/${data.totalGames}), Set取得率 ${overallSetWinRate}`);
}
