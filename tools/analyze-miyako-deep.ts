import { benchmarkDb, findBenchmarkDeck } from "../src/ai/benchmark-fixtures";
import { createGame, applyDecision } from "../src/engine/engine";
import { benchmarkPolicyDecision, seededRnd, configureIsmctsBenchmark } from "../src/ai/benchmark";

const opponents = [
  "梟谷-第三彈官方",
  "音駒-音駒-二口干擾",
  "音駒-音駒-三彈官方",
  "白鳥沢-三彈優化",
  "伊達工業-攔網軸改_韋宏"
];

const versions = [
  { name: "1張版", deckName: "ユース-合宿精英-優化_名分流單張版", copies: 1 },
  { name: "2張版", deckName: "ユース-合宿精英-優化_名分流雙張版", copies: 2 },
  { name: "3張版", deckName: "ユース-合宿精英-優化_名分流三張版", copies: 3 }
];

// Configure MCTS to run fast (32 iterations)
configureIsmctsBenchmark({
  iterations: 32,
  explorationC: Math.SQRT2,
  candidateLimit: 8,
  leafRolloutHorizon: 40
});

console.log("Starting deep analysis of Miyako-Komori (HV-PR-059) usage (v2)...");

for (const ver of versions) {
  const deckA = findBenchmarkDeck(ver.deckName);
  
  let totalMatches = 0;
  let matchesWithMiyakoDrawn = 0; 
  let matchesWithMiyakoInOpening = 0; 
  
  let totalMiyakoDeploys = 0;
  let deployTypes = { serve: 0, block: 0, receive: 0, toss: 0, attack: 0 };
  let deployAs = { Miyako: 0, Miya: 0, Komori: 0, unknown: 0 };
  let deployWins = 0; 
  let deployMatches = 0;
  
  let event86Uses = 0; 

  for (const oppName of opponents) {
    const deckB = findBenchmarkDeck(oppName);
    
    for (let gameIdx = 0; gameIdx < 10; gameIdx++) {
      const seed = 100 + gameIdx;
      totalMatches++;
      
      const randomByPlayer: [() => number, () => number] = [
        seededRnd(seed * 3 + 11),
        seededRnd(seed * 5 + 17)
      ];
      
      let state = createGame(benchmarkDb, {
        seed,
        decks: [deckA.ids, deckB.ids]
      });
      
      let miyakoDrawnInThisMatch = false;
      let miyakoInOpeningThisMatch = false;
      let checkOpeningHand = true;
      let miyakoDeployedInThisMatch = false;
      
      for (let step = 0; step < 5000; step++) {
        if (state.phase === "gameOver") break;
        const pending = state.pendingDecision;
        if (!pending) break;
        
        const player = pending.player;
        
        // Track hand of Player 0
        const p0HandCardIds = state.players[0].hand.map(uid => state.cards[uid]);
        if (p0HandCardIds.includes("HV-PR-059")) {
          miyakoDrawnInThisMatch = true;
        }
        
        // Accurate opening hand check (first time setupStage becomes "done")
        if (state.setupStage === "done" && checkOpeningHand) {
          if (p0HandCardIds.includes("HV-PR-059")) {
            miyakoInOpeningThisMatch = true;
          }
          checkOpeningHand = false;
        }
        
        const decision = benchmarkPolicyDecision(
          player === 0 ? "is-mcts" : "is-mcts",
          benchmarkDb,
          state,
          randomByPlayer,
          [deckA.axes, deckB.axes],
          [deckA.ids, deckB.ids],
          []
        );
        
        // Check decision if Player 0 is deploying Miyako-Komori
        if (player === 0) {
          let deployedUids: number[] = [];
          let isToss = false;
          let isAttack = false;
          let isReceive = false;
          let isBlock = false;
          let isServe = false;
          
          if (decision.type === "deploy-serve" && decision.uid !== null) {
            deployedUids.push(decision.uid);
            isServe = true;
          } else if (decision.type === "deploy-block" && decision.uids !== null) {
            deployedUids.push(...decision.uids);
            isBlock = true;
          } else if (decision.type === "deploy-receive" && decision.uid !== null) {
            deployedUids.push(decision.uid);
            isReceive = true;
          } else if (decision.type === "deploy-toss" && decision.uid !== null) {
            deployedUids.push(decision.uid);
            isToss = true;
          } else if (decision.type === "deploy-attack" && decision.uid !== null) {
            deployedUids.push(decision.uid);
            isAttack = true;
          }
          
          // Check event 86 usage
          if (decision.type === "free" && decision.action === "event" && state.cards[decision.uid] === "HV-P03-086") {
            event86Uses++;
          }
          
          for (const uid of deployedUids) {
            if (state.cards[uid] === "HV-PR-059") {
              totalMiyakoDeploys++;
              miyakoDeployedInThisMatch = true;
              
              if (isServe) deployTypes.serve++;
              if (isBlock) deployTypes.block++;
              if (isReceive) deployTypes.receive++;
              if (isToss) deployTypes.toss++;
              if (isAttack) deployTypes.attack++;
              
              let choice = (decision as any).nameChoice || ((decision as any).nameChoices && (decision as any).nameChoices[uid]);
              if (choice) {
                if (choice.includes("宮") && choice.includes("侑")) deployAs.Miya++;
                else if (choice.includes("古森")) deployAs.Komori++;
                else deployAs.Miyako++;
              } else {
                deployAs.unknown++;
              }
            }
          }
        }
        
        state = applyDecision(benchmarkDb, state, decision);
      }
      
      if (miyakoDrawnInThisMatch) matchesWithMiyakoDrawn++;
      if (miyakoInOpeningThisMatch) matchesWithMiyakoInOpening++;
      if (miyakoDeployedInThisMatch) {
        deployMatches++;
        if (state.winner === 0) deployWins++;
      }
    }
  }
  
  console.log(`\n=== ${ver.name}宮古森 (${ver.copies}張) 統計 ===`);
  console.log(`- 總場數: ${totalMatches}`);
  console.log(`- 整場上手率: ${(matchesWithMiyakoDrawn / totalMatches * 100).toFixed(1)}% (${matchesWithMiyakoDrawn}/${totalMatches})`);
  console.log(`- mulligan後起手上手率: ${(matchesWithMiyakoInOpening / totalMatches * 100).toFixed(1)}% (${matchesWithMiyakoInOpening}/${totalMatches})`);
  console.log(`- 宮・古森總登場次數: ${totalMiyakoDeploys}`);
  console.log(`- 登場位置分佈: 托球位(toss)=${deployTypes.toss}, 接球位(receive)=${deployTypes.receive}, 攔網位(block)=${deployTypes.block}, 發球位(serve)=${deployTypes.serve}, 攻擊位(attack)=${deployTypes.attack}`);
  console.log(`- 登場宣告名稱: 宮侑=${deployAs.Miya}, 古森=${deployAs.Komori}, 原始宮古森=${deployAs.Miyako}, 未知=${deployAs.unknown}`);
  console.log(`- 宮・古森上場的對局數: ${deployMatches}`);
  console.log(`- 宮・古森上場且獲勝的對局數: ${deployWins} (勝率 ${(deployWins / (deployMatches || 1) * 100).toFixed(1)}%)`);
  console.log(`- 事件卡「おりこうさん(086)」宣告次數: ${event86Uses}`);
}
