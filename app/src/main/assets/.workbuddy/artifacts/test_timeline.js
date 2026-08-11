// 模拟 buildRoundsFromStream 逻辑（从 app_summary_memory.js 提取的纯函数）
function buildRoundsFromStream(stream) {
  let rounds = [];
  let cur = { userMsgContent: "", charMsgContent: "", timestamp: 0, ids: [], srcs: [], _isOffline: false, _doneAll: true };
  const flush = () => {
    if (cur.userMsgContent && cur.charMsgContent) rounds.push(cur);
    cur = { userMsgContent: "", charMsgContent: "", timestamp: 0, ids: [], srcs: [], _isOffline: false, _doneAll: true };
  };
  for (const m of stream) {
    if (m.senderType === 'user') {
      if (cur.userMsgContent && cur.charMsgContent) flush();
      cur.userMsgContent = cur.userMsgContent ? cur.userMsgContent + "\n" + m.content : m.content;
      cur.timestamp = m.timestamp || cur.timestamp;
      cur.ids.push(m.id);
      cur.srcs.push(m._src);
      if (m._src === 'offline') cur._isOffline = true;
      if (m._done !== true) cur._doneAll = false;
    } else if (m.senderType === 'char') {
      if (cur.userMsgContent) {
        cur.charMsgContent = cur.charMsgContent ? cur.charMsgContent + "\n" + m.content : m.content;
      }
      cur.ids.push(m.id);
      cur.srcs.push(m._src);
      if (m._src === 'offline') cur._isOffline = true;
      if (m._done !== true) cur._doneAll = false;
    } else if (m.senderType === 'system' && m.contentType === 'call') {
      try {
        const callData = JSON.parse(m.content);
        const callSummary = callData.summary || (callData.type === 'video' ? '视频' : '语音') + '通话 ' + (callData.durationSec || 0) + '秒';
        if (cur.userMsgContent && cur.charMsgContent) flush();
        cur.userMsgContent = cur.userMsgContent ? cur.userMsgContent + "\n[" + callSummary + "]" : "[" + callSummary + "]";
        if (!cur.timestamp) cur.timestamp = m.timestamp;
        cur.ids.push(m.id);
        cur.srcs.push(m._src);
        if (m._done !== true) cur._doneAll = false;
      } catch(e) {}
    }
  }
  flush();
  return rounds;
}

let pass = 0, fail = 0;
function assert(cond, name) { if (cond) { pass++; console.log("  OK " + name); } else { fail++; console.log("  FAIL: " + name); } }

console.log("场景1：线上5轮 -> 赴约3轮（时间上穿插在中间）-> 线上3轮");
let ts = 1000;
let stream = [];
for (let i = 1; i <= 5; i++) { stream.push({ senderType:'user', content:'线上U'+i, timestamp: ts++, id: i*10, _src:'online' }); stream.push({ senderType:'char', content:'线上C'+i, timestamp: ts++, id: i*10+1, _src:'online' }); }
for (let i = 1; i <= 3; i++) { stream.push({ senderType:'user', content:'赴约U'+i, timestamp: ts++, id: 500+i*2, _src:'offline' }); stream.push({ senderType:'char', content:'赴约C'+i, timestamp: ts++, id: 500+i*2+1, _src:'offline' }); }
for (let i = 6; i <= 8; i++) { stream.push({ senderType:'user', content:'线上U'+i, timestamp: ts++, id: i*10, _src:'online' }); stream.push({ senderType:'char', content:'线上C'+i, timestamp: ts++, id: i*10+1, _src:'online' }); }
stream.sort((a,b) => a.timestamp - b.timestamp);
const rounds1 = buildRoundsFromStream(stream);
const pattern1 = rounds1.map(r => r._isOffline ? '线下' : '线上').join(',');
assert(rounds1.length === 11, "轮次数应为 11（线上8轮+线下3轮）实际 " + rounds1.length);
assert(pattern1 === '线上,线上,线上,线上,线上,线下,线下,线下,线上,线上,线上', "时间线模式正确: " + pattern1);
assert(JSON.stringify(rounds1[5].ids) === JSON.stringify([502,503]), "线下轮 ids 正确: " + JSON.stringify(rounds1[5].ids));
let onlineIds = [], offlineIds = [];
for (let i = 0; i < 6; i++) { rounds1[i].ids.forEach((id,idx) => { if (rounds1[i].srcs[idx]==='offline') offlineIds.push(id); else onlineIds.push(id); }); }
assert(offlineIds.length === 2 && onlineIds.length === 10, "进度标记分配（总结前6轮=线上1-5+线下1）：线下2条+线上10条，实际 线下" + offlineIds.length + " 线上" + onlineIds.length);

console.log("场景2：多次来回切换（线上3 -> 赴约2 -> 线上3 -> 赴约1 -> 线上2）");
ts = 2000; stream = [];
for (let i = 1; i <= 3; i++) { stream.push({ senderType:'user', content:'U'+i, timestamp: ts++, id: i, _src:'online' }); stream.push({ senderType:'char', content:'C'+i, timestamp: ts++, id: i+100, _src:'online' }); }
stream.push({ senderType:'user', content:'F1', timestamp: ts++, id: 900, _src:'offline' }); stream.push({ senderType:'char', content:'F1r', timestamp: ts++, id: 901, _src:'offline' });
stream.push({ senderType:'user', content:'F2', timestamp: ts++, id: 902, _src:'offline' }); stream.push({ senderType:'char', content:'F2r', timestamp: ts++, id: 903, _src:'offline' });
for (let i = 4; i <= 6; i++) { stream.push({ senderType:'user', content:'U'+i, timestamp: ts++, id: i, _src:'online' }); stream.push({ senderType:'char', content:'C'+i, timestamp: ts++, id: i+100, _src:'online' }); }
stream.push({ senderType:'user', content:'F3', timestamp: ts++, id: 904, _src:'offline' }); stream.push({ senderType:'char', content:'F3r', timestamp: ts++, id: 905, _src:'offline' });
for (let i = 7; i <= 8; i++) { stream.push({ senderType:'user', content:'U'+i, timestamp: ts++, id: i, _src:'online' }); stream.push({ senderType:'char', content:'C'+i, timestamp: ts++, id: i+100, _src:'online' }); }
stream.sort((a,b) => a.timestamp - b.timestamp);
const rounds2 = buildRoundsFromStream(stream);
const pattern = rounds2.map(r => r._isOffline ? '线下' : '线上').join(',');
assert(pattern === '线上,线上,线上,线下,线下,线上,线上,线上,线下,线上,线上', "穿插模式正确: " + pattern);
assert(rounds2.length === 11, "总轮数 11，实际 " + rounds2.length);
// _doneAll 统计：仅线上1-3轮（ts 2000-2005）标记已总结
stream.forEach(m => { m._done = (m._src === 'online' && m.timestamp <= 2005); });
const rounds2b = buildRoundsFromStream(stream);
let doneCount = 0;
for (const r of rounds2b) { if (r.ids.length > 0 && r._doneAll) doneCount++; }
assert(doneCount === 3, "已总结轮次统计=3（前3轮线上），实际 " + doneCount);

console.log("场景3：线上消息中混杂系统灰字与通话记录（不破坏轮次）");
ts = 3000; stream = [];
stream.push({ senderType:'user', content:'U1', timestamp: ts++, id: 1, _src:'online' });
stream.push({ senderType:'system', content:'[系统通知] 对方领取了你的红包', contentType:'text', timestamp: ts++, id: 2, _src:'online' });
stream.push({ senderType:'char', content:'C1', timestamp: ts++, id: 3, _src:'online' });
stream.push({ senderType:'system', content:'{"type":"voice","summary":"聊了3分钟","durationSec":180}', contentType:'call', timestamp: ts++, id: 4, _src:'online' });
stream.push({ senderType:'user', content:'U2', timestamp: ts++, id: 5, _src:'online' });
stream.push({ senderType:'char', content:'C2', timestamp: ts++, id: 6, _src:'online' });
stream.sort((a,b) => a.timestamp - b.timestamp);
const rounds3 = buildRoundsFromStream(stream);
assert(rounds3.length === 2, "应合并为 2 轮（通话并入第2轮），实际 " + rounds3.length);
assert(rounds3[1].userMsgContent.includes('聊了3分钟'), "通话摘要并入第2轮: " + rounds3[1].userMsgContent);

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);
