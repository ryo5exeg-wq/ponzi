
"use strict";
/* ============================================================
   ポンジスキーム エンジン
   DOMに触らない純ロジック部（テストはここをnodeで実行する）
   ============================================================ */

/* ---------- 乱数（シード固定でテスト再現可） ---------- */
let RNG = mulberry32(20260817);
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function rnd(n){return Math.floor(RNG()*n);}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=rnd(i+1);const t=a[i];a[i]=a[j];a[j]=t;}return a;}

/* ---------- 産業・贅沢品 ---------- */
const IND=[
  {name:'運輸業',  short:'運輸',  icon:'🚢'},
  {name:'食品業',  short:'食品',  icon:'🌾'},
  {name:'放送業',  short:'放送',  icon:'📡'},
  {name:'不動産業',short:'不動産',icon:'🏛'}
];
const LUX=[{price:30,vp:1,icon:'💎'},{price:56,vp:2,icon:'🚗'},{price:78,vp:3,icon:'🛥'},{price:96,vp:4,icon:'🏺'}];
const IND_STOCK=15;      // 1種あたりの在庫
const MARKET_SIZE=9;     // 資金列の枚数

/* ---------- 資金カード 全72枚（実データ） ----------
   金額は 9〜80 の連番で各1枚ずつ。スタート9枚(9〜17)／一般45枚(18〜62)／熊18枚(63〜80)。
   カード右下の利回り% = 配当 ÷ (金額×周期)。周期は4枚ごとに 5→4→3 を繰り返し、
   熊の65以降は全て周期3（＝最も首が回らなくなる）。
   出典: 実装 peter-de-boer/ponzischeme_webapp の fundCards() を、
   ルールブックで実物を確認できた4枚（9/5/8・25/4/27・72/3/128・80/3/144）と照合して採用。 */
const START_CARDS=[  // [金額,周期,配当]
  [9,5,8],[10,5,9],[11,5,10],[12,5,11],
  [13,4,10],[14,4,11],[15,4,12],[16,4,13],
  [17,3,11]];
const GEN_CARDS=[
  [18,3,12],[19,3,13],[20,3,14],
  [21,5,26],[22,5,28],[23,5,30],[24,5,32],
  [25,4,27],[26,4,29],[27,4,31],[28,4,33],
  [29,3,26],[30,3,27],[31,3,28],[32,3,29],
  [33,5,57],[34,5,59],[35,5,61],[36,5,63],
  [37,4,53],[38,4,55],[39,4,57],[40,4,59],
  [41,3,46],[42,3,48],[43,3,50],[44,3,52],
  [45,5,102],[46,5,105],[47,5,108],[48,5,111],
  [49,4,91],[50,4,93],[51,4,95],[52,4,98],
  [53,3,75],[54,3,77],[55,3,79],[56,3,81],
  [57,5,162],[58,5,165],[59,5,168],[60,5,171],
  [61,4,140],[62,4,143]];
const BEAR_CARDS=[
  [63,4,146],[64,4,149],
  [65,3,114],[66,3,116],[67,3,118],[68,3,120],
  [69,3,122],[70,3,124],[71,3,126],[72,3,128],
  [73,3,130],[74,3,132],[75,3,134],[76,3,136],
  [77,3,138],[78,3,140],[79,3,142],[80,3,144]];

let CID=0;
function mkCard(c,kind){return {id:++CID,amt:c[0],cyc:c[1],pay:c[2],kind:kind};}
function buildCards(){
  CID=0;
  const start=START_CARDS.map(function(c){return mkCard(c,'start');});
  const gen  =GEN_CARDS.map(function(c){return mkCard(c,'gen');});
  const bear =BEAR_CARDS.map(function(c){return mkCard(c,'bear');});
  return {start:start,pile:shuffle(gen.concat(bear))};
}

/* ---------- 得点 ---------- */
function indVP(n){return n*(n+1)/2;}
function cashVP(c){return c>=96?4:c>=78?3:c>=56?2:c>=30?1:0;}

/* ---------- 状態 ---------- */
let G=null;
const AI_NAMES=['アリス','ボブ','キャロル','ダン','イヴ'];

function newGame(opt){
  opt=opt||{};
  const n=opt.n||4;
  RNG=mulberry32(opt.seed||(20260817+Math.floor(Date.now?Date.now()%100000:0)));
  const cards=buildCards();
  const players=[];
  for(let i=0;i<n;i++){
    players.push({
      i:i,
      name:(i===0&&!opt.watch)?'あなた':AI_NAMES[i],
      ai:(i!==0)||!!opt.watch,
      cash:0,
      ind:[0,0,0,0],
      disc:[[],[],[],[],[],[]],   // 0=矢印, 1..5
      lux:[],
      out:false,                  // 破産
      raised:0,                   // 公開情報: 募集した金額の累計
      paidOut:0,                  // 公開情報: 配当支払いの累計
      luxSpent:0,                 // 公開情報
      obs:new Array(n).fill(0)    // 自分が当事者だった取引による各人の現金増減（自分の知識）
    });
  }
  G={
    n:n, advanced:!!opt.advanced, watch:!!opt.watch,
    players:players,
    market:cards.start.slice(),
    deck:cards.pile, discard:[], removed:[],
    supply:[IND_STOCK,IND_STOCK,IND_STOCK,IND_STOCK],
    luxLeft:[true,true,true,true],
    round:1, startP:0, phase:'fund', cursor:0, sub:0,
    crashed:false, pending:null, over:false, result:null,
    log:[], bugs:[]
  };
  sortMarket();
  logR('ラウンド 1');
  logP('資金募集');
  return G;
}

/* ---------- ログ ---------- */
function say(t,c){G.log.push({t:t,c:c||''});}
function logR(t){say(t,'r');}
function logP(t){say('― '+t+' ―','ph');}

/* ---------- 資金列 ---------- */
function sortMarket(){G.market.sort(function(a,b){return a.amt-b.amt||a.id-b.id;});}
function drawOne(){
  if(!G.deck.length){
    if(!G.discard.length)return null;
    G.deck=shuffle(G.discard.slice()); G.discard=[];
    say('山札が尽きたので廃棄置き場を混ぜ直した','ph');
  }
  return G.deck.pop();
}
function refillMarket(){
  while(G.market.length<MARKET_SIZE){const c=drawOne(); if(!c)break; G.market.push(c);}
  sortMarket();
}
function marketRow(r){ // r=0,1,2 → その列のカード
  const out=[];
  for(let i=r*3;i<r*3+3&&i<G.market.length;i++)out.push(G.market[i]);
  return out;
}
function rowOfCard(c){const i=G.market.indexOf(c);return i<0?-1:Math.floor(i/3);}
function bearCount(){return G.market.filter(function(c){return c.kind==='bear';}).length;}

/* ---------- 円盤 ---------- */
function discCards(p){ // 矢印以外の全カード
  const out=[];for(let s=0;s<=5;s++)for(const c of p.disc[s])out.push(c);return out;
}
function dueIn(p,k){ // 今から k ラウンド以内に払う配当の合計
  let s=0;
  for(let pos=1;pos<=5;pos++)for(const c of p.disc[pos])
    for(let t=pos;t<=k;t+=c.cyc)s+=c.pay;
  for(const c of p.disc[0])for(let t=0;t<=k;t+=c.cyc)if(t>=0)s+=c.pay; // 通常ここは空
  return s;
}
function perRound(p){ // 1ラウンドあたりの平均負担
  let s=0;for(const c of discCards(p))s+=c.pay/c.cyc;return s;
}
function rotate(steps){
  for(const p of G.players){
    const nd=[[],[],[],[],[],[]];
    for(let pos=0;pos<=5;pos++)for(const c of p.disc[pos])nd[Math.max(0,pos-steps)].push(c);
    p.disc=nd;
  }
}

/* ---------- 順番 ---------- */
function order(){const o=[];for(let k=0;k<G.n;k++)o.push((G.startP+k)%G.n);return o;}
function curPlayer(){return G.players[order()[G.cursor]];}

/* ---------- 資金募集 ---------- */
function canTakeInd(p,t){return p.ind[t]<3 && G.supply[t]>0;}
function legalFund(p){ // [{t, cards:[...]}]
  const out=[];
  for(let t=0;t<4;t++){
    if(!canTakeInd(p,t))continue;
    const row=marketRow(p.ind[t]); // 取った後の枚数 = ind+1 → 列 index = ind
    if(row.length)out.push({t:t,row:p.ind[t],cards:row});
  }
  return out;
}
function doFund(p,t,card){
  const legal=legalFund(p).find(function(x){return x.t===t;});
  if(!legal)return false;
  if(legal.cards.indexOf(card)<0)return false;
  G.supply[t]--; p.ind[t]++;
  const idx=G.market.indexOf(card); G.market.splice(idx,1);
  p.cash+=card.amt; p.raised+=card.amt;
  p.disc[card.cyc].push(card);
  refillMarket();
  say(p.name+'が'+IND[t].icon+IND[t].name+'を取り、'+(legal.row+1)+'列目から $'+card.amt
      +'（周期'+card.cyc+'・配当'+card.pay+'）を募集',p.i===0&&!G.watch?'me':'');
  return true;
}

/* ---------- インサイダー取引 ---------- */
function tradeTargets(p){ // 双方が1枚以上持っている種類
  const out=[];
  for(const q of G.players){
    if(q===p||q.out)continue;
    const ts=[];
    for(let t=0;t<4;t++)if(p.ind[t]>=1&&q.ind[t]>=1)ts.push(t);
    if(ts.length)out.push({j:q.i,types:ts});
  }
  return out;
}
/* 相手の判断: 'sell'（金をもらい産業を渡す） or 'buy'（同額払って産業をもらう） */
function targetDecide(q,actor,t,price){
  if(q.cash<price)return 'sell';                      // 買い戻す現金がない＝売るしかない
  if(simLife(q,q.cash-price,null,LIFE_MAX)<2)return 'sell'; // 買ったら次で払えない
  const K=vpRate(q);
  const gainSell=price-q.ind[t]*K;                    // 売る: 現金+price, 得点-ind[t]
  const gainBuy =(q.ind[t]+1)*K-price;                // 買う: 現金-price, 得点+(ind+1)
  const lifeGain=(simLife(q,q.cash+price,null,LIFE_MAX)-simLife(q,q.cash-price,null,LIFE_MAX))*4;
  return (gainSell+lifeGain>=gainBuy)?'sell':'buy';
}
function applyTrade(a,b,t,price,dec){
  if(dec==='sell'){                 // bが売る: a→price, b→産業1枚をaへ
    a.cash-=price; b.cash+=price;
    b.ind[t]--; a.ind[t]++;
    a.obs[a.i]-=price; a.obs[b.i]+=price;
    b.obs[a.i]-=price; b.obs[b.i]+=price;
  }else{                            // bが買う: bがprice払い、aの産業1枚をもらう
    b.cash-=price; a.cash+=price;
    a.ind[t]--; b.ind[t]++;
    a.obs[a.i]+=price; a.obs[b.i]-=price;
    b.obs[a.i]+=price; b.obs[b.i]-=price;
  }
  const dirTxt=(dec==='sell')
    ? b.name+'は「売る」を選んだ（'+IND[t].name+'が'+a.name+'へ）'
    : b.name+'は「買う」を選んだ（'+IND[t].name+'が'+b.name+'へ）';
  say(a.name+'→'+b.name+'に'+IND[t].icon+IND[t].name+'の取引：'+dirTxt,'tr');
}

/* ---------- 贅沢品（アドバンス） ---------- */
function doLux(p,k){
  if(!G.advanced||!G.luxLeft[k]||p.cash<LUX[k].price)return false;
  p.cash-=LUX[k].price; p.luxSpent+=LUX[k].price; G.luxLeft[k]=false; p.lux.push(k);
  say(p.name+'が贅沢品 '+LUX[k].icon+' $'+LUX[k].price+' を購入（'+LUX[k].vp+'点）','tr');
  return true;
}

/* ---------- 除去・暴落・配当 ---------- */
function doRemove(p,card){
  const i=G.market.indexOf(card); if(i<0)return false;
  G.market.splice(i,1);
  if(card.kind==='start'){G.removed.push(card);say(p.name+'が資金列から $'+card.amt+'（スタートカード）を除去→ゲームから除外');}
  else{G.discard.push(card);say(p.name+'が資金列から $'+card.amt+(card.kind==='bear'?'（熊）':'')+' を除去');}
  refillMarket();
  return true;
}
function maxIndTypes(p){
  let mx=0;for(let t=0;t<4;t++)if(p.ind[t]>mx)mx=p.ind[t];
  if(mx===0)return [];
  const out=[];for(let t=0;t<4;t++)if(p.ind[t]===mx)out.push(t);
  return out;
}
function doCrashDiscard(p,t){
  const legal=maxIndTypes(p);
  if(!legal.length)return true;
  if(legal.indexOf(t)<0)return false;
  p.ind[t]--; G.supply[t]++;
  say(p.name+'は'+IND[t].icon+IND[t].name+'を1枚廃棄','bad');
  return true;
}
function doCrash(){
  const bears=G.market.filter(function(c){return c.kind==='bear';});
  G.market=G.market.filter(function(c){return c.kind!=='bear';});
  for(const b of bears)G.discard.push(b);
  G.deck=shuffle(G.deck.concat(G.discard)); G.discard=[];
  refillMarket();
  say('★株価大暴落！ 熊カード'+bears.length+'枚を廃棄し山札を作り直した。全員が産業を1枚失う','bad');
}
function payout(){
  const fails=[];
  for(const pi of order()){
    const p=G.players[pi];
    let due=0;for(const c of p.disc[0])due+=c.pay;
    if(due===0){say(p.name+'は支払いなし','ph');continue;}
    if(p.cash<due){
      p.out=true;fails.push(p);
      say(p.name+'は配当 '+due+' を支払えない！（所持金'+p.cash+'）→ 破産','bad');
    }else{
      p.cash-=due;p.paidOut+=due;
      say(p.name+'が配当 '+due+' を支払った','good');
    }
    const moved=p.disc[0].slice(); p.disc[0]=[];
    for(const c of moved)p.disc[c.cyc].push(c);
  }
  return fails;
}

/* ---------- 得点 ---------- */
function scoreOf(p){
  let v=0;
  for(let t=0;t<4;t++)v+=indVP(p.ind[t]);
  for(const k of p.lux)v+=LUX[k].vp;
  if(!G.advanced)v+=cashVP(p.cash);
  return v;
}
function tieBreak(p){let mx=0;for(const c of discCards(p))if(c.amt>mx)mx=c.amt;return mx;}
function finish(fails){
  G.over=true;
  const alive=G.players.filter(function(p){return !p.out;});
  const rows=G.players.map(function(p){
    return {p:p,name:p.name,out:p.out,vp:p.out?0:scoreOf(p),
            ind:p.ind.slice(),cash:p.cash,tb:tieBreak(p),
            lux:p.lux.reduce(function(s,k){return s+LUX[k].vp;},0)};
  });
  let win=null;
  if(alive.length){
    const cand=rows.filter(function(r){return !r.out;});
    cand.sort(function(a,b){return b.vp-a.vp||b.tb-a.tb;});
    win=cand[0];
  }
  rows.sort(function(a,b){return (a.out?1:0)-(b.out?1:0)||b.vp-a.vp||b.tb-a.tb;});
  G.result={rows:rows,win:win,fails:fails.map(function(p){return p.name;}),allDead:!alive.length};
  say(win?('🏆 '+win.name+'の勝ち（'+win.vp+'点）'):'全員が破産＝全員の負け','r');
  return G.result;
}

/* ============================================================
   AI
   ============================================================ */
function vpRate(p){ // 1点を現金いくらと見るか（余裕があるほど点を高く買う）
  const life=simLife(p,p.cash,null,LIFE_MAX);
  return Math.max(11,Math.min(44,8+life*3.6));
}
function estCash(observer,j){ // 公開情報＋自分が当事者だった取引だけから推定
  const q=G.players[j];
  if(observer.i===j)return q.cash;
  return Math.max(0,q.raised-q.paidOut-q.luxSpent+observer.obs[j]);
}
/* 収入が一切ない前提で、あと何ラウンド配当を払い続けられるか（最大maxR）。
   このゲームの本質＝「自分の寿命 vs 一番先に潰れる人の寿命」なので、
   AIはこの数字を軸に借りるか降りるかを決める。 */
const LIFE_MAX=10;
function simLife(p,cash,extra,maxR){
  maxR=maxR||LIFE_MAX;
  let d=[[],[],[],[],[],[]];
  for(let s=0;s<=5;s++)for(const c of p.disc[s])d[s].push(c);
  if(extra){d[extra.cyc].push(extra);cash+=extra.amt;}
  for(let r=1;r<=maxR;r++){
    const nd=[[],[],[],[],[],[]];
    for(let s=0;s<=5;s++)for(const c of d[s])nd[Math.max(0,s-1)].push(c);
    let due=0;for(const c of nd[0])due+=c.pay;
    if(cash<due)return r-1;
    cash-=due;
    const mv=nd[0];nd[0]=[];
    for(const c of mv)nd[c.cyc].push(c);
    d=nd;
  }
  return maxR;
}
function weakestOpponent(p){ // 一番先に潰れそうな相手の寿命（公開情報＋推定のみ）
  let mn=99;
  for(const q of G.players){
    if(q===p||q.out)continue;
    const l=simLife(q,estCash(p,q.i),null,LIFE_MAX);
    if(l<mn)mn=l;
  }
  return mn===99?LIFE_MAX:mn;
}
function aiFund(p){
  const legal=legalFund(p);
  if(!legal.length)return null;
  const curLife=simLife(p,p.cash,null,LIFE_MAX);
  const weak=weakestOpponent(p);
  /* ゲームは「一番先に潰れる人」が出た瞬間に終わる。
     だから寿命は「最弱の相手＋2」まであれば十分で、それ以上に価値はない。
     余裕があるほど得点（産業）を優先し、危ないほど寿命を優先する形になる。 */
  const need=Math.min(LIFE_MAX,weak+2);
  let best=null;
  for(const L of legal){
    const mvp=p.ind[L.t]+1;                        // 同種 n→n+1 の得点増
    for(const c of L.cards){
      const life=simLife(p,p.cash,c,LIFE_MAX);
      if(life<2&&curLife>=2)continue;              // 自殺する借金はしない
      const y=c.pay/(c.amt*c.cyc);                 // 利率（低いほど良い借金）
      // 同点のときの好み（在庫の多い産業＋AIごとの癖）。全員が同じ産業に群がらないように。
      const taste=G.supply[L.t]*0.02+((p.i*7+L.t*3)%5)*0.12;
      const v=mvp*3.0 + Math.min(life,need)*2.2 - y*7 + taste;
      if(!best||v>best.v)best={v:v,t:L.t,c:c,life:life};
    }
  }
  if(!best)return null;
  if(G.round<=1)return best;                       // 初手は借りる（産業0では何もできない）
  if(curLife<=1)return best;                       // 待ったなし
  const skipV=Math.min(curLife,need)*2.2;
  if(best.v<=skipV+0.3)return null;
  return best;
}
function aiTrade(p){
  const cands=tradeTargets(p);
  if(!cands.length)return null;
  const K=vpRate(p);
  const myLife=simLife(p,p.cash,null,LIFE_MAX);
  const weak=weakestOpponent(p);
  const cashW=(myLife<=weak+1)?1.35:1.0;           // 自分が危ないなら現金を重く見る
  let best=null;
  for(const c of cands){
    const q=G.players[c.j];
    const ecash=estCash(p,c.j);
    for(const t of c.types){
      const indiff=(q.ind[t]+0.5)*K;               // 相手が売り買い無差別になる価格
      const cand=[Math.max(1,Math.round(indiff)+2),
                  Math.max(1,Math.round(indiff)-2),
                  Math.max(1,Math.round(ecash*0.9)),   // 相手の財布を突く（払えなければ売るしかない）
                  Math.max(1,Math.round(indiff*0.6))];
      for(const P of cand){
        if(P>p.cash)continue;
        const dec=predictDecide(p,c.j,t,P);
        let v;
        if(dec==='sell'){                          // 私が買う（現金が減る）
          if(simLife(p,p.cash-P,null,LIFE_MAX)<2)continue;
          v=(p.ind[t]+1)*K - P*cashW;
        }else{                                     // 私が売る（現金が増える）
          v=P*cashW - p.ind[t]*K;
        }
        if(!best||v>best.v)best={v:v,j:c.j,t:t,P:P,dec:dec};
      }
    }
  }
  if(!best||best.v<3)return null;
  return best;
}
function predictDecide(observer,j,t,price){
  const q=G.players[j];
  if(estCash(observer,j)<price)return 'sell';
  const K=vpRate(observer);                     // 相手のレートは自分基準で推測
  const gainSell=price-q.ind[t]*K;
  const gainBuy =(q.ind[t]+1)*K-price;
  return gainSell>=gainBuy?'sell':'buy';
}
function aiLux(p){
  if(!G.advanced)return null;
  let best=null;
  for(let k=0;k<4;k++){
    if(!G.luxLeft[k])continue;
    if(simLife(p,p.cash-LUX[k].price,null,LIFE_MAX)<4)continue;  // 4ラウンド分の余裕は残す
    const v=LUX[k].vp*24-LUX[k].price*0.25;
    if(!best||v>best.v)best={v:v,k:k};
  }
  return best;
}
function aiRemove(p){
  // 資金が苦しい＝暴落は避けたい → 熊を除去。余裕がある＝良いカードを他人から隠す
  const weak=dueIn(p,3)>p.cash;
  const bears=G.market.filter(function(c){return c.kind==='bear';});
  const near=bearCount()>=G.n-1;
  if(bears.length&&(weak||near)){
    let mx=bears[0];for(const b of bears)if(b.amt>mx.amt)mx=b;
    return mx;
  }
  // 一番利率の良い（他人が欲しがる）カードを消す
  let best=G.market[0];
  for(const c of G.market){
    const y=c.pay/(c.amt*c.cyc);
    if(y<best.pay/(best.amt*best.cyc))best=c;
  }
  return best;
}
function aiCrashDiscard(p){
  const legal=maxIndTypes(p);
  if(!legal.length)return null;
  // 得点の損が小さい＝枚数が同じなら好きな方。将来集めにくい種類を捨てる
  let best=legal[0],bs=-1e9;
  for(const t of legal){
    const s=-(G.supply[t])*0.1;   // 在庫が多い＝また取れる
    if(s>bs){bs=s;best=t;}
  }
  return best;
}

/* ============================================================
   進行（1呼び出しで1ステップだけ進む）
   pending が立つと人間の入力待ち
   ============================================================ */
function step(){
  if(G.over||G.pending)return false;
  const ph=G.phase;

  if(ph==='fund'||ph==='insider'){
    if(G.cursor>=G.n){
      if(ph==='fund'){G.phase='insider';G.cursor=0;logP('インサイダー取引');}
      else{G.phase='pass';G.cursor=0;G.sub=0;}
      return false;
    }
    const p=curPlayer();
    if(p.out){G.cursor++;return false;}
    if(!p.ai){G.pending={kind:ph,pi:p.i};return false;}
    // --- AIの手 ---
    if(ph==='fund'){
      const m=aiFund(p);
      if(m){ if(!doFund(p,m.t,m.c))G.bugs.push('doFund拒否: '+p.name+' t='+m.t+' card='+m.c.amt); }
      else say(p.name+'は資金募集をスキップ','ph');
    }else{
      const lx=aiLux(p), tr=aiTrade(p);
      if(lx&&(!tr||lx.v>tr.v+6))doLux(p,lx.k);
      else if(tr){
        const q=G.players[tr.j];
        if(q.ai){const dec=targetDecide(q,p,tr.t,tr.P);applyTrade(p,q,tr.t,tr.P,dec);}
        else{G.pending={kind:'decide',pi:q.i,from:p.i,t:tr.t,P:tr.P};return true;}
      }else say(p.name+'は取引をスキップ','ph');
    }
    G.cursor++;
    return true;
  }

  if(ph==='pass'){
    if(G.sub===0){
      G.startP=(G.startP+1)%G.n;
      let g=0;while(G.players[G.startP].out&&g++<G.n)G.startP=(G.startP+1)%G.n;
      logP('スタートプレイヤーマークを '+G.players[G.startP].name+' へ');
      G.sub=1;return true;
    }
    const p=G.players[G.startP];
    if(!p.ai){G.pending={kind:'remove',pi:p.i};return false;}
    const c=aiRemove(p); if(c)doRemove(p,c);
    G.phase='crash';G.cursor=0;G.sub=0;
    return true;
  }

  if(ph==='crash'){
    if(G.sub===0){
      G.crashed=bearCount()>=G.n;
      if(!G.crashed){G.phase='rotate';return false;}
      doCrash(); G.sub=1; G.cursor=0; return true;
    }
    if(G.cursor>=G.n){G.phase='rotate';G.sub=0;return false;}
    const p=curPlayer();
    if(p.out||!maxIndTypes(p).length){G.cursor++;return false;}
    if(!p.ai){G.pending={kind:'crashDiscard',pi:p.i};return false;}
    doCrashDiscard(p,aiCrashDiscard(p));
    G.cursor++;return true;
  }

  if(ph==='rotate'){
    const steps=G.crashed?2:1;
    rotate(steps);
    logP('時間が'+steps+'マス進んだ'+(G.crashed?'（暴落で銀行取付け）':''));
    G.phase='payout';return true;
  }

  if(ph==='payout'){
    logP('配当金の支払い');
    const fails=payout();
    if(fails.length){finish(fails);return true;}
    G.round++;G.crashed=false;G.phase='fund';G.cursor=0;G.sub=0;
    logR('ラウンド '+G.round);logP('資金募集');
    return true;
  }
  return false;
}

/* ---------- 人間の操作 ---------- */
function actFund(t,card){
  const pd=G.pending; if(!pd||pd.kind!=='fund')return false;
  const p=G.players[pd.pi];
  if(!doFund(p,t,card))return false;
  G.pending=null;G.cursor++;return true;
}
function actSkip(){
  const pd=G.pending; if(!pd)return false;
  const p=G.players[pd.pi];
  if(pd.kind==='fund'){say(p.name+'は資金募集をスキップ','ph');G.pending=null;G.cursor++;return true;}
  if(pd.kind==='insider'){say(p.name+'は取引をスキップ','ph');G.pending=null;G.cursor++;return true;}
  return false;
}
function actTrade(j,t,P){
  const pd=G.pending; if(!pd||pd.kind!=='insider')return false;
  const p=G.players[pd.pi],q=G.players[j];
  if(P<1||P>p.cash)return false;
  if(p.ind[t]<1||q.ind[t]<1)return false;
  const dec=targetDecide(q,p,t,P);
  applyTrade(p,q,t,P,dec);
  G.pending=null;G.cursor++;return true;
}
function actLux(k){
  const pd=G.pending; if(!pd||pd.kind!=='insider')return false;
  if(!doLux(G.players[pd.pi],k))return false;
  G.pending=null;G.cursor++;return true;
}
function actDecide(dec){
  const pd=G.pending; if(!pd||pd.kind!=='decide')return false;
  const q=G.players[pd.pi],a=G.players[pd.from];
  if(dec==='buy'&&q.cash<pd.P)dec='sell';
  applyTrade(a,q,pd.t,pd.P,dec);
  G.pending=null;G.cursor++;return true;
}
function actRemove(card){
  const pd=G.pending; if(!pd||pd.kind!=='remove')return false;
  if(!doRemove(G.players[pd.pi],card))return false;
  G.pending=null;G.phase='crash';G.cursor=0;G.sub=0;return true;
}
function actCrashDiscard(t){
  const pd=G.pending; if(!pd||pd.kind!=='crashDiscard')return false;
  if(!doCrashDiscard(G.players[pd.pi],t))return false;
  G.pending=null;G.cursor++;return true;
}
/* ============================================================
   サーバー側API（Cloudflare Worker と ソロ版 の両方がこれを使う）
   ボムバスターズ／ブロックスと同じ形に合わせてある。
   ★隠し情報＝所持金 と 封筒の金額。viewFor がそれを削って返す。
   ============================================================ */

/* 盤面を丸ごと入れ替える／取り出す（Durable Object が保存・復元に使う） */
function getState(){return G;}
function setState(s){G=s;}

/* 席 seat から見てよい情報だけにした盤面を返す。
   seat<0（観戦・不明ID）は全員の所持金を伏せる。 */
function viewFor(seat){
  if(!G)return null;
  const v=JSON.parse(JSON.stringify(G));
  v.you=seat;
  v.players.forEach(function(p,i){
    p.isYou=(i===seat);
    if(i!==seat){
      /* 所持金は屏風の裏＝見せない。公開情報から推測できる値だけ添える */
      p.cashHidden=true;
      p.cashGuess=Math.max(0,(p.raised||0)-(p.paidOut||0)-(p.luxSpent||0));
      delete p.cash;
      delete p.obs;          // 他人の取引メモも見せない
    }else{
      p.cashHidden=false;
    }
  });
  /* 進行中の封筒: 中身は当事者2人だけが見てよい */
  if(v.pending&&v.pending.kind==='decide'){
    const involved=(v.pending.pi===seat)||(v.pending.from===seat);
    if(!involved)delete v.pending.P;
  }
  /* ゲーム終了後は全部公開（得点計算の確認のため） */
  if(v.over){
    v.players.forEach(function(p,i){p.cashHidden=false;p.cash=G.players[i].cash;});
  }
  return v;
}

/* 新しい対戦を開始する。seats = [{name, ai}] */
function createGame(opts){
  opts=opts||{};
  const n=Math.min(5,Math.max(3,(opts.seats&&opts.seats.length)||4));
  newGame({n:n,advanced:!!opts.advanced,seed:opts.seed,watch:true});
  if(opts.seats){
    opts.seats.forEach(function(s,i){
      if(!G.players[i])return;
      G.players[i].name=s.name||G.players[i].name;
      G.players[i].ai=!!s.ai;
      G.players[i].human=!s.ai;   /* 人が座っている席かどうか（切断しても変わらない） */
    });
  }
  G.players.forEach(function(p){ if(p.human===undefined)p.human=!p.ai; });
  return G;
}

/* 接続中の席だけを人間として扱い、あとはAI代行にしてから進める。
   worker がポーリングのたびに呼ぶ入口。activeSeats = いま接続中の席番号の配列 */
function serverStep(activeSeats){
  if(!G)return 0;
  const act=new Set(activeSeats||[]);
  G.players.forEach(function(p,i){
    const shouldBeAI = !p.human || !act.has(i);
    if(p.ai!==shouldBeAI) setSeatAI(i,shouldBeAI);
  });
  return serverAdvance();
}

/* 席 seat がいま入力を求められているか */
function waitingFor(){return G&&G.pending?G.pending.pi:-1;}

/* 人間の手を適用する。呼び出し側は席の一致を必ず確認すること。
   戻り値 {ok:true} / {error:'...'} */
function applyAction(seat,a){
  if(!G)return {error:'no game'};
  if(G.over)return {error:'ゲームは終了しています'};
  const pd=G.pending;
  if(!pd)return {error:'いまは入力を受け付けていません'};
  if(pd.pi!==seat)return {error:'あなたの手番ではありません'};
  a=a||{};
  let ok=false;
  switch(a.type){
    case 'fund':{
      const card=G.market.find(function(c){return c.id===a.cardId;});
      if(!card)return {error:'そのカードは資金列にありません'};
      ok=actFund(a.t,card); break;
    }
    case 'skip':      ok=actSkip(); break;
    case 'trade':     ok=actTrade(a.j,a.t,Math.floor(a.price)); break;
    case 'lux':       ok=actLux(a.k); break;
    case 'decide':    ok=actDecide(a.dec==='buy'?'buy':'sell'); break;
    case 'remove':{
      const card=G.market.find(function(c){return c.id===a.cardId;});
      if(!card)return {error:'そのカードは資金列にありません'};
      ok=actRemove(card); break;
    }
    case 'crashDiscard': ok=actCrashDiscard(a.t); break;
    default: return {error:'不明な操作です'};
  }
  return ok?{ok:true}:{error:'その操作はルール上できません'};
}

/* AI・自動進行を、人間の入力待ちになるまで進める。
   maxSteps は暴走よけ。戻り値は進めた回数。 */
function serverAdvance(maxSteps){
  maxSteps=maxSteps||400;
  let n=0;
  while(!G.over&&!G.pending&&n<maxSteps){ step(); n++; }
  return n;
}

/* 席の担当を人間⇄AIに切り替える（切断中はAI代行、復帰で人間に戻す）。
   その席が入力待ちのまま切断された場合は、待ちを解いてAIに引き継がせる。
   解かないと serverAdvance が動けず、部屋全体が止まってしまう。 */
function setSeatAI(seat,isAI){
  if(!G||!G.players[seat])return;
  G.players[seat].ai=!!isAI;
  if(!isAI||!G.pending||G.pending.pi!==seat)return;
  if(G.pending.kind==='decide'){
    /* 封筒への返事だけは「やり直し」ができない（相手はもう金額を出している）。
       AIの判断で決着させ、取引を宙ぶらりんにしない。 */
    const q=G.players[seat], a=G.players[G.pending.from];
    const dec=targetDecide(q,a,G.pending.t,G.pending.P);
    applyTrade(a,q,G.pending.t,G.pending.P,dec);
    G.pending=null; G.cursor++;
  }else{
    G.pending=null;   /* 同じ手番をAIとしてやり直させる */
  }
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={
    /* --- サーバー用 --- */
    createGame:createGame, getState:getState, setState:setState, viewFor:viewFor,
    applyAction:applyAction, serverAdvance:serverAdvance, serverStep:serverStep, waitingFor:waitingFor, setSeatAI:setSeatAI,
    /* --- ソロ版・テスト用 --- */
    newGame:newGame, step:step,
    IND:IND, LUX:LUX, buildCards:buildCards, indVP:indVP, cashVP:cashVP,
    dueIn:dueIn, legalFund:legalFund, tradeTargets:tradeTargets, targetDecide:targetDecide,
    scoreOf:scoreOf, bearCount:bearCount, marketRow:marketRow, maxIndTypes:maxIndTypes,
    simLife:simLife, estCash:estCash,
    START_CARDS:START_CARDS, GEN_CARDS:GEN_CARDS, BEAR_CARDS:BEAR_CARDS,
    actFund:actFund, actSkip:actSkip, actTrade:actTrade, actDecide:actDecide,
    actRemove:actRemove, actCrashDiscard:actCrashDiscard, actLux:actLux
  };
}
