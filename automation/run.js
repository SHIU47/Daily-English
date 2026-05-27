#!/usr/bin/env node
/**
 * Daily English News Automation
 * 東旭每日英文新聞自動化腳本
 * 全程使用 Gemini API（免費）+ Telegram 選新聞
 * 使用方式: node run.js
 */

require('dotenv').config();
const fs = require('fs');

const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN;
const GITHUB_OWNER     = process.env.GITHUB_OWNER || 'SHIU47';
const GITHUB_REPO      = process.env.GITHUB_REPO  || 'Daily-English';
const TG_TOKEN         = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID       = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_TIMEOUT = parseInt(process.env.TELEGRAM_TIMEOUT) || 15 * 60 * 1000; // 預設 15 分鐘

const GEMINI_TEXT_URL  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const GEMINI_IMAGE_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${GEMINI_API_KEY}`;

// ── 日期工具 ──────────────────────────────────────────────────────────────────
function getTodayStrings() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  const d   = String(now.getDate()).padStart(2, '0');
  const abbrs = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return {
    dotDate:   `${y}.${m}.${d}`,
    plainDate: `${y}${m}${d}`,
    slashDate: `${y}/${m}/${d}`,
    dashMonth: `${y}-${m}`,
    display:   `${abbrs[parseInt(m)-1]} ${d}, ${y}`,
    year: y, month: m, day: d
  };
}

// ── Console 工具 ──────────────────────────────────────────────────────────────
function printHeader(step, title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  Step ${step}: ${title}`);
  console.log('='.repeat(60));
}
const ok   = (msg) => console.log(`  OK  ${msg}`);
const info = (msg) => console.log(`  >>  ${msg}`);
const warn = (msg) => console.log(`  !!  ${msg}`);

// ── Gemini 文字 API ───────────────────────────────────────────────────────────
async function geminiChat(prompt, useSearch = false, retries = 5) {
  // 備用模型清單，包含最新旗艦與輕量化模型，防止單一模型高負載或額度超限
  const models = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];
  
  for (let i = 0; i < retries; i++) {
    const modelName = models[i % models.length];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    
    try {
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
          temperature: 0.7, 
          maxOutputTokens: 8192
        }
      };
      if (useSearch) {
        payload.tools = [{ googleSearch: {} }];
      } else {
        payload.generationConfig.responseMimeType = "application/json";
      }
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000); // 90秒超時防止掛起
      
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      const data = await res.json();
      if (data.error) throw new Error(`Gemini Error (${modelName}): ${data.error.message}`);
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) {
      warn(`Gemini (${modelName}) 呼叫失敗 (${i+1}/${retries}): ${err.message}`);
      
      if (i === retries - 1) {
        throw new Error(`Gemini API 呼叫多次均失敗，最後錯誤: ${err.message}`);
      }
      
      const isQuotaOrSpike = err.message.includes('429') || 
                             err.message.includes('Quota') || 
                             err.message.includes('limit') || 
                             err.message.includes('high demand') || 
                             err.message.includes('temporarily') ||
                             err.message.includes('503') ||
                             err.message.includes('UNAVAILABLE');
                             
      const wait = isQuotaOrSpike ? (10 + i * 5) : 3; // 縮短重試延遲，並在 503 Spikes 時也能快速備份重試
      warn(`將在 ${wait} 秒後更換下一個備用模型重試...`);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
}


// ── Telegram 工具 ─────────────────────────────────────────────────────────────
async function tgCall(method, params = {}, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超時保護
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (!data.ok) warn(`Telegram ${method} 失敗: ${data.description}`);
      return data;
    } catch (err) {
      warn(`Telegram ${method} 網路錯誤 (${i+1}/${retries}): ${err.message}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 5000));
      else throw err;
    }
  }
}

const tgSend = (text, extra = {}) =>
  tgCall('sendMessage', { chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', ...extra });

const tgSendButtons = (text, keyboard) =>
  tgCall('sendMessage', {
    chat_id: TG_CHAT_ID, text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });

const tgEdit = (msgId, text, keyboard = null) =>
  tgCall('editMessageText', {
    chat_id: TG_CHAT_ID, message_id: msgId, text, parse_mode: 'HTML',
    ...(keyboard !== null ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });

const tgAnswer = (cbId) =>
  tgCall('answerCallbackQuery', { callback_query_id: cbId });

// ── 等待 N 個按鈕選擇 ─────────────────────────────────────────────────────────
async function waitForSelections(count, prefix, onSelect, initialSelected = []) {
  let offset;
  const selected = [...initialSelected];
  const deadline = Date.now() + TELEGRAM_TIMEOUT;

  const init = await tgCall('getUpdates', { limit: 1, timeout: 1, offset: -1 });
  if (init && init.result?.length) {
    offset = init.result[init.result.length - 1].update_id + 1;
  }

  while (selected.length < count && Date.now() < deadline) {
    const updates = await tgCall('getUpdates', {
      timeout: 5,
      allowed_updates: ['callback_query'],
      ...(offset != null ? { offset } : {})
    });

    if (!updates || !updates.ok) {
      warn('Telegram getUpdates 失敗，等待 5 秒後重試，防止 active webhook 造成無延遲無限迴圈爆破...');
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    for (const upd of (updates.result || [])) {
      offset = upd.update_id + 1;
      const cb = upd.callback_query;
      if (!cb) continue;
      await tgAnswer(cb.id);

      const val = cb.data;
      if (val === prefix + ':REFRESH') {
        return { action: 'refresh', selected };
      }
      if (!val.startsWith(prefix + ':')) continue;
      const id = val.replace(prefix + ':', '');
      if (selected.includes(id)) continue;

      selected.push(id);
      if (onSelect) await onSelect(selected, cb.message?.message_id);

      if (selected.length >= count) {
        return { action: 'done', selected };
      }
    }
  }
  return { action: 'done', selected };
}

// ── Step 1: Gemini 搜尋產生新聞清單 ──────────────────────────────────────────
async function generateNews(dates, excludeTitles = []) {
  printHeader(1, '搜尋今日新聞 (Gemini)');

  let historyStr = "";
  try {
    if (fs.existsSync('./history.json')) {
      const history = JSON.parse(fs.readFileSync('./history.json', 'utf8'));
      if (history.length > 0) {
        historyStr = `\n\n【防重複指令】近期已經報導過以下這些新聞，請務必尋找最新發生的事件，絕對不可以重複產生與以下相似主題的新聞：\n- ${history.join('\n- ')}\n`;
      }
    }
  } catch (err) {
    warn('無法讀取 history.json: ' + err.message);
  }

  let excludeStr = '';
  if (excludeTitles.length > 0) {
    excludeStr = `\n\n【本次已顯示過，絕對不可重複】此次換批過程中以下新聞已出現過，新一批必須是全新不同的主題：\n- ${excludeTitles.join('\n- ')}\n`;
  }

  const prompt = `今天是 ${dates.dotDate}。
請根據最近 24-48 小時內真實發生的最新重大新聞（包含今天的新聞，若今日新聞較少可直接使用昨日新聞），產生一份新聞清單，用於台灣英文學習網站。
【重要要求】
1. 請務必使用連網搜尋 (Google Search) 查證該事件確實是真實發生的重大新聞，絕對不可憑空捏造或通靈。
2. 你必須且只能輸出符合以下格式的純 JSON 字串，絕對不要包含任何 markdown 標記（如 \`\`\`json）或任何對話式、解釋性或道歉的文字（絕對不要回覆 "I'm sorry, I cannot..." ）。
3. 即便搜尋結果中符合今天的新聞數量不足，也必須用最近一兩天內查證屬實的新聞填滿。
${historyStr}${excludeStr}

請產生：
- 8 則台灣新聞：涵蓋台灣政治、經濟、社會、科技、台積電、半導體等
- 12 則國際新聞：涵蓋 AI/科技、地緣政治、金融市場、國際大事等

每則新聞請提供：
1. 簡短中文標題（10-15字，有力道）
2. 簡短英文標題（10-15個字）
3. 分類標籤：只能是以下其中一個 [台灣政治, 台灣經濟, 台灣社會, 科技, 地緣政治, 金融市場, 國際大事]

格式如下：
{
  "taiwan": [{"id":1,"zh":"中文標題","en":"English Headline","tag":"分類"}],
  "international": [{"id":1,"zh":"中文標題","en":"English Headline","tag":"分類"}]
}`;

  let news = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const text = await geminiChat(prompt, true);
    const raw = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      warn(`第 ${attempt} 次新聞 JSON 擷取失敗，原始回應已記錄到 error_news_${attempt}.txt`);
      fs.writeFileSync(`./error_news_${attempt}.txt`, raw, 'utf8');
      if (attempt < 3) { await new Promise(r => setTimeout(r, 5000)); continue; }
      throw new Error('無法解析新聞 JSON（已重試 3 次）');
    }
    try {
      news = JSON.parse(match[0]);
      break;
    } catch (err) {
      warn(`第 ${attempt} 次 JSON 解析失敗: ${err.message}，已記錄到 error_news_${attempt}.txt`);
      fs.writeFileSync(`./error_news_${attempt}.txt`, match[0], 'utf8');
      if (attempt < 3) { await new Promise(r => setTimeout(r, 5000)); continue; }
      throw new Error('新聞 JSON 解析失敗（已重試 3 次）');
    }
  }

  ok(`台灣新聞 ${news.taiwan.length} 則 / 國際新聞 ${news.international.length} 則`);
  return news;
}

// ── Step 2: Telegram 互動選新聞 ───────────────────────────────────────────────
async function selectNewsViaTelegram(news, dates) {
  printHeader(2, 'Telegram 互動選新聞');
  let currentNews = news;
  const AUTO_SELECT = process.env.AUTO_SELECT === 'true';

  async function selectCategory(categoryKey, categoryName, emoji, reqCount, prefix) {
    let finalSelectedObjs = [];
    let allShownTitles = []; // 記錄本次所有已顯示過的標題（防重複用）
    
    while (finalSelectedObjs.length < reqCount) {
      const remaining = reqCount - finalSelectedObjs.length;
      const list = currentNews[categoryKey];

      // 把這批新聞標題記錄下來（換一批時傳給 Gemini 避免重複）
      for (const n of list) {
        if (!allShownTitles.includes(n.zh)) allShownTitles.push(n.zh);
      }
      
      const headerMsg = finalSelectedObjs.length > 0 
        ? `\n\n✅ <b>已保留 ${finalSelectedObjs.length} 則，請再選 ${remaining} 則：</b>\n` 
        : `（請選 ${reqCount} 則）\n\n`;
        
      const text = `${emoji} <b>${categoryName}</b> ${headerMsg}` +
        list.map(n => `<b>${n.id}.</b> [${n.tag}] ${n.zh}\n<i>${n.en}</i>`).join('\n\n');

      const kb = [];
      for (let i = 0; i < list.length; i += 2) {
        const row = [{ text: `${list[i].id}. ${list[i].zh}`, callback_data: `${prefix}:${list[i].id}` }];
        if (list[i+1]) row.push({ text: `${list[i+1].id}. ${list[i+1].zh}`, callback_data: `${prefix}:${list[i+1].id}` });
        kb.push(row);
      }
      kb.push([{ text: `🔄 換一批${categoryName}`, callback_data: `${prefix}:REFRESH` }]);

      // 如果是 AUTO_SELECT 模式，直接自動選取前幾則，不發送按鈕等待
      if (AUTO_SELECT) {
        info(`[自動選擇模式] 自動選取 ${categoryName}`);
        const remainingCount = reqCount - finalSelectedObjs.length;
        let added = 0;
        for (const n of list) {
          if (!finalSelectedObjs.find(o => o.id === n.id && o.zh === n.zh)) {
            finalSelectedObjs.push(n);
            added++;
            if (added >= remainingCount) break;
          }
        }
        break;
      }

      const msg = await tgSendButtons(text, kb);
      const msgId = msg.result?.message_id;
      info(`${categoryName}訊息已發送 (需再選 ${remaining} 則)`);

      const result = await waitForSelections(remaining, prefix, async (sel) => {
        const done = sel.length === remaining;
        await tgEdit(msgId,
          text + `\n\n✅ 此批已選 ${sel.length}/${remaining} 則${done ? '\n\n👇 繼續下一步' : ''}`,
          done ? [] : kb
        );
      });

      if (result.action === 'refresh') {
        // 換一批：先保留此批中已選的，再重新生成
        for (const id of result.selected) {
          const found = list.find(n => n.id === parseInt(id));
          if (found && !finalSelectedObjs.find(o => o.id === found.id && o.zh === found.zh)) {
            finalSelectedObjs.push(found);
          }
        }
        const kept = finalSelectedObjs.length;
        await tgEdit(msgId, text + `\n\n🔄 已請求換一批（保留 ${kept} 則）...`, []);
        info(`使用者請求換一批 ${categoryName}，已保留 ${kept} 則`);
        await tgSend(`🔄 正在重新搜尋新聞（已為您保留 ${kept} 則），請稍候...`);
        // 傳入本次所有已顯示過的標題，讓 Gemini 避免重複
        currentNews = await generateNews(dates, allShownTitles);
      } else {
        // 正常選完：把這批結果加進 finalSelectedObjs
        for (const id of result.selected) {
          const found = list.find(n => n.id === parseInt(id));
          if (found && !finalSelectedObjs.find(o => o.id === found.id && o.zh === found.zh)) {
            finalSelectedObjs.push(found);
          }
        }

        // 檢查是否選滿，若未選滿（超時）則自動補充
        if (finalSelectedObjs.length < reqCount) {
          warn(`${categoryName} 選取未完成或超時，自動補充剩餘項目`);
          const remainingCount = reqCount - finalSelectedObjs.length;
          let autoSelected = 0;
          for (const n of list) {
            if (!finalSelectedObjs.find(o => o.id === n.id && o.zh === n.zh)) {
              finalSelectedObjs.push(n);
              autoSelected++;
              if (autoSelected >= remainingCount) break;
            }
          }
          await tgSend(`⚠️ <b>${categoryName}</b> 選取未完成或超時，系統已自動補充：\n` + 
            finalSelectedObjs.map(n => `· ${n.zh}`).join('\n'));
        }
        break;
      }
    }
    
    ok(`${categoryName}已選: ${finalSelectedObjs.map(n => n.zh).join(' / ')}`);
    return finalSelectedObjs;
  }

  await tgSend(`📅 <b>${dates.display}</b>`);
  const selectedTW = await selectCategory('taiwan', '台灣新聞', '🇹🇼', 3, 'TW');
  const selectedINT = await selectCategory('international', '國際新聞', '🌍', 4, 'INT');

  // 封面新聞
  const allSelected = [...selectedTW, ...selectedINT];
  const coverText =
    `🖼️ <b>請選封面新聞</b>（1 則）\n\n` +
    allSelected.map((n, i) => `<b>${i+1}.</b> ${n.zh}`).join('\n');

  let coverNews;
  if (AUTO_SELECT) {
    info(`[自動選擇模式] 自動選取封面新聞`);
    coverNews = allSelected[0];
  } else {
    const coverKb = allSelected.map((n, i) => ([{
      text: `${i+1}. ${n.zh}`,
      callback_data: `COVER:${i}`
    }]));

    const coverMsg = await tgSendButtons(coverText, coverKb);
    const coverMsgId = coverMsg.result?.message_id;

    const coverResult = await waitForSelections(1, 'COVER', async (sel) => {
      const idx = parseInt(sel[0]);
      await tgEdit(coverMsgId, coverText + `\n\n✅ 封面：${allSelected[idx].zh}`, []);
    });

    if (coverResult.selected.length < 1) {
      warn('封面選取超時，自動選擇第一則新聞作為封面');
      coverNews = allSelected[0];
      await tgSend(`⚠️ 封面選取超時，系統已自動選擇第一則作為封面：\n· ${coverNews.zh}`);
    } else {
      coverNews = allSelected[parseInt(coverResult.selected[0])];
    }
  }
  ok(`封面: ${coverNews.zh}`);

  await tgSend(
    `✅ <b>選新聞完成！正在產生內容...</b>\n\n` +
    `🇹🇼 ${selectedTW.map(n => n.zh).join(' · ')}\n` +
    `🌍 ${selectedINT.map(n => n.zh).join(' · ')}\n` +
    `🖼️ 封面：${coverNews.zh}`
  );

  return { selectedTW, selectedINT, allSelected, coverNews };
}

// ── Step 3: Gemini 產生 HTML 學習內容 ────────────────────────────────────────
async function generateNewsHTML(selection, dates) {
  printHeader(3, '產生英文新聞學習內容 (逐篇迴圈生成)');
  info('正在逐篇產生 7 篇新聞的閱讀、單字、練習題...');

  const articles = [];
  const msgRes = await tgSend('📝 <b>正在開始逐篇產生學習教材</b>\n\n這會需要幾分鐘，請稍候 (0/7)...');
  const msgId = msgRes.result?.message_id;

  for (let i = 0; i < selection.allSelected.length; i++) {
    const n = selection.allSelected[i];
    info(`進度 [${i+1}/7]: ${n.zh}`);
    
    if (msgId) {
      await tgEdit(msgId, `📝 <b>正在產生學習教材</b>\n\n📌 <b>進度 [${i+1}/7]</b>\n👉 <i>${n.zh}</i>\n...`).catch(() => {});
    }

        const prompt = `你是一個專業的英文語文學習內容編輯，請為以下**這篇新聞**製作一份中英雙語新聞學習材料。
日期：${dates.dotDate}
新聞標題：[${n.tag}] 中文：${n.zh} | 英文：${n.en}

請產生：
1. english：這篇新聞的英文內文（B2 程度，約 80 字，factual 風格，至少 3 句）。
2. chinese：上述英文新聞的專業中文翻譯。
3. vocabulary：20 個重點單字/片語，必須照 "英文 (詞性.): 中文翻譯" 的字串陣列格式。
4. quiz：12 道選擇題，格式為 [{"q": "題目", "options": ["A", "B", "C", "D"], "answer": "正確選項文字"}]。

只輸出一個以大括號 {} 包裹的純 JSON 物件，不要輸出任何 markdown 標記（如 codeblocks）：
{
  "english": "這篇新聞的英文內文",
  "chinese": "上述英文的中文翻譯",
  "vocabulary": ["word (n.): 意思是...", "another (v.): ..."],
  "quiz": [{"q":"...", "options":["..."], "answer":"..."}]
}`;

    const text = await geminiChat(prompt, false); // useSearch = false
    const raw = text.replace(/```json/g, "").replace(/```/g, "").trim();
    
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      require('fs').writeFileSync(`./error_json_${i}.txt`, raw, 'utf8');
      throw new Error(`第 ${i+1} 篇 JSON 取出失敗，已記錄到 error_json_${i}.txt`);
    }

    try {
      const parsed = JSON.parse(match[0]);
      articles.push({
        id: 'article-' + i,
        tabTitle: n.tag,
        title: n.zh,
        english: parsed.english,
        chinese: parsed.chinese,
        vocab: parsed.vocabulary,
        quiz: parsed.quiz
      });
      ok(`單篇完成: ${n.zh}`);
      
      // 插入 10 秒安全延遲，避免瞬間打光 Gemini 免費版 15 RPM 的限流額度
      info('API 限流保護：冷卻 10 秒...');
      await new Promise(r => setTimeout(r, 10000));
    } catch (err) {
      require('fs').writeFileSync(`./error_json_${i}.txt`, match[0], 'utf8');
      throw new Error(`第 ${i+1} 篇 JSON 解析失敗：${err.message} (已紀錄到 error_json_${i}.txt)`);
    }
  }

  if (msgId) {
    await tgEdit(msgId, '✅ <b>7 篇學習教材逐篇產生完畢！</b>即將進入最後排版...').catch(() => {});
  }
  return articles;
}



// ── Step 3b: 組合 HTML 檔案 ───────────────────────────────────────────────────
function buildNewsHTML(articles, dates, selection) {
  let subtitleText = dates.display;
  if (selection && selection.allSelected && selection.allSelected.length >= 5) {
    subtitleText = `${dates.display}：${selection.allSelected[0].tag}、${selection.allSelected[3].tag} 與 ${selection.allSelected[4].tag}`;
  }
  const newsDataObj = {};
  
  if (articles.length >= 3) {
    const twFocus = {
      title: '台灣本地焦點',
      english: '',
      chinese: '',
      vocabulary: [],
      quiz: []
    };
    
    for (let i = 0; i < 3; i++) {
      const a = articles[i];
      twFocus.english += `[${i+1}] ${a.title}\n${a.english}\n\n`;
      twFocus.chinese += `【${i+1}】${a.title}\n${a.chinese}\n\n`;
      twFocus.vocabulary.push(...a.vocab);
      twFocus.quiz.push(...a.quiz);
    }
    twFocus.english = twFocus.english.trim();
    twFocus.chinese = twFocus.chinese.trim();
    
    newsDataObj['taiwan-focus'] = twFocus;
    
    for (let i = 3; i < articles.length; i++) {
      const a = articles[i];
      newsDataObj[a.id] = {
        title: a.title,
        tabTitle: a.tabTitle,
        english: a.english,
        chinese: a.chinese,
        vocabulary: a.vocab,
        quiz: a.quiz
      };
    }
  } else {
    articles.forEach(a => {
      newsDataObj[a.id] = {
        title: a.title,
        tabTitle: a.tabTitle,
        english: a.english,
        chinese: a.chinese,
        vocabulary: a.vocab,
        quiz: a.quiz
      };
    });
  }
  
  const beforeTemplate = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>每日英文新聞深度學習：\${dates.display}</title>
    <!-- Tailwind CSS for modern, responsive design -->
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { 
            font-family: 'Inter', sans-serif; 
            background-color: #f8fafc; 
            min-height: 100vh;
        }
        .container-card {
            background-color: #ffffff;
            border-radius: 1rem; 
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.05);
        }
        .main-tabs-container {
            background-color: #f1f5f9; 
            border-radius: 1rem 1rem 0 0;
            padding: 1rem 1.25rem 0 1.25rem;
            overflow-x: auto;
            white-space: nowrap;
            -webkit-overflow-scrolling: touch;
        }
        .main-tab-button {
            padding: 0.75rem 1.25rem;
            margin-bottom: -1px; 
            border-bottom: 3px solid transparent;
            font-weight: 600;
            color: #64748b; 
            transition: all 0.2s ease;
            cursor: pointer;
            display: inline-block;
        }
        .main-tab-button.active {
            color: #2563eb; 
            border-bottom-color: #2563eb; 
            background-color: #ffffff;
            border-radius: 0.5rem 0.5rem 0 0;
        }
        .sub-tab-button {
            padding: 0.5rem 1rem;
            margin-right: 0.5rem;
            border-radius: 0.5rem;
            font-weight: 500;
            color: #475569;
            background-color: #f1f5f9;
            transition: all 0.2s;
            cursor: pointer;
        }
        .sub-tab-button.active {
            color: #ffffff;
            background-color: #3b82f6; 
            box-shadow: 0 4px 6px rgba(59, 130, 246, 0.2);
        }
        .quiz-option {
            transition: all 0.2s;
            cursor: pointer;
        }
        .quiz-option:hover { background-color: #f1f5f9; }
        .quiz-option.selected { border-color: #3b82f6; background-color: #eff6ff; }
        .quiz-option.correct { background-color: #dcfce7; border-color: #10b981; font-weight: 700; }
        .quiz-option.incorrect { background-color: #fee2e2; border-color: #ef4444; font-weight: 700; }

        .prose p {
            white-space: pre-wrap;
            line-height: 1.8;
            margin-bottom: 1em;
        }
        ::-webkit-scrollbar { height: 6px; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
    </style>
</head>
<body class="p-4 sm:p-10">
    <div class="max-w-7xl mx-auto">
        <header class="text-center mb-10">
            <h1 class="text-3xl sm:text-5xl font-black text-slate-900 tracking-tight">每日英語新聞深度學習</h1>
            <p class="mt-2 text-blue-600 font-bold uppercase tracking-widest">${subtitleText}</p>
        </header>

        <div class="container-card overflow-hidden border border-slate-200">
            <!-- Main News Tabs -->
            <div id="main-tabs" class="main-tabs-container border-b border-slate-200"></div>

            <!-- Content Area -->
            <div id="content-area" class="p-6 sm:p-12">
                <div class="text-center p-20 text-slate-400">
                    <p class="text-xl">內容加載中...</p>
                </div>
            </div>
        </div>

        <footer class="text-center mt-10 text-slate-400 text-sm">
            <p>© 2026 Professional English Learning Program. Designed for Strategic Leadership.</p>
        </footer>
    </div>

    <script>
        `;
  const afterTemplate = `
        if(Object.keys(NEWS_DATA).length > 0) { currentTopicId = Object.keys(NEWS_DATA)[0]; } 
        let currentSubTab = 'article'; 
        let quizState = {}; 
        let quizResult = {}; 

        function renderTabs() {
            const tabsContainer = document.getElementById('main-tabs');
            tabsContainer.innerHTML = Object.entries(NEWS_DATA).map(([id, data]) => {
                const isActive = id === currentTopicId ? 'active' : '';
                const displayTitle = data.title.includes('：') ? data.title.split('：')[0] : data.title;
                return \`<button class="main-tab-button \${isActive}" onclick="changeTopic('\${id}')">\${displayTitle}</button>\`;
            }).join('');
        }

        function renderContent() {
            const contentArea = document.getElementById('content-area');
            const data = NEWS_DATA[currentTopicId];
            if (!data) return;
            const quizLength = data.quiz ? data.quiz.length : 0;
            const subTabsHTML = \`
                <div class="mb-8 flex space-x-2 border-b pb-4 border-slate-100 overflow-x-auto">
                    <button class="sub-tab-button \${currentSubTab === 'article' ? 'active' : ''}" onclick="changeSubTab('article')">📰 英文原文</button>
                    <button class="sub-tab-button \${currentSubTab === 'translation' ? 'active' : ''}" onclick="changeSubTab('translation')">🇹🇼 中文翻譯</button>
                    <button class="sub-tab-button \${currentSubTab === 'vocabulary' ? 'active' : ''}" onclick="changeSubTab('vocabulary')">📚 單字庫 (\${data.vocabulary.length})</button>
                    <button class="sub-tab-button \${currentSubTab === 'quiz' ? 'active' : ''}" onclick="initQuiz()">📝 測驗 (\${quizLength} 題)</button>
                </div>
            \`;
            let contentHTML = '';
            switch (currentSubTab) {
                case 'article': contentHTML = renderArticle(data.english, data.title); break;
                case 'translation': contentHTML = renderTranslation(data.chinese, data.title); break;
                case 'vocabulary': contentHTML = renderVocabulary(data.vocabulary, data.title); break;
                case 'quiz': contentHTML = renderQuiz(currentTopicId, data.quiz, data.title); break;
            }
            contentArea.innerHTML = subTabsHTML + contentHTML;
            if (currentSubTab === 'quiz') updateQuizDisplay(currentTopicId, data.quiz);
        }

        function renderArticle(text, title) {
            return \`<h2 class="text-3xl font-extrabold text-slate-900 mb-6 leading-tight">\${title}</h2><div class="prose max-w-none text-lg text-slate-700 leading-relaxed p-6 bg-blue-50 rounded-2xl border border-blue-100 shadow-sm"><p>\${text.trim()}</p></div><div class="mt-8 text-center"><button class="px-8 py-3 bg-blue-600 text-white font-bold rounded-xl shadow-lg hover:bg-blue-700 transition" onclick="changeSubTab('translation')">🇹🇼 前往中文翻譯</button></div>\`;
        }

        function renderTranslation(text, title) {
            return \`<h2 class="text-3xl font-extrabold text-gray-900 mb-6 leading-tight">\${title}</h2><div class="prose max-w-none text-lg text-gray-700 leading-relaxed p-6 bg-green-50 border-l-8 border-green-500 rounded-2xl shadow-sm"><p>\${text.trim()}</p></div><div class="mt-8 text-center"><button class="px-8 py-3 bg-green-600 text-white font-bold rounded-xl shadow-lg hover:bg-green-700 transition" onclick="changeSubTab('vocabulary')">📖 前往單字庫複習</button></div>\`;
        }

        function renderVocabulary(vocabArray, title) {
            const listItems = vocabArray.map(item => {
                const parts = item.split(': ');
                return \`<li class="p-4 bg-white rounded-xl shadow-sm border border-gray-200 hover:shadow-md transition"><span class="font-bold text-blue-700">\${parts[0]}</span> <span class="text-slate-500 block text-sm mt-1">\${parts[1]}</span></li>\`;
            }).join('');
            return \`<h2 class="text-3xl font-extrabold text-slate-900 mb-8">核心單字與片語</h2><ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">\${listItems}</ul><div class="mt-12 text-center"><button class="px-8 py-3 bg-indigo-600 text-white font-bold rounded-xl shadow-lg hover:bg-indigo-700 transition" onclick="initQuiz()">📝 開始測驗</button></div>\`;
        }

        function renderQuiz(topicId, quizQuestions, title) {
            const currentQuizState = quizState[topicId] || {};
            const result = quizResult[topicId];
            const questionsHTML = quizQuestions.map((q, index) => {
                const selected = currentQuizState[index];
                const isSubmitted = result !== undefined;
                const optionsHTML = q.options.map((option, optIndex) => {
                    let classes = 'quiz-option p-4 my-2 border-2 border-gray-100 rounded-xl block text-left';
                    if (isSubmitted) {
                        if (option === q.answer) classes += ' correct';
                        else if (selected === option) classes += ' incorrect';
                    } else if (selected === option) classes += ' selected';
                    const escapedOption = option.replace(/'/g, "\\'");
                    return \`<div class="\${classes} \${isSubmitted ? 'pointer-events-none' : ''}" onclick="selectOption('\${topicId}', \${index}, '\${escapedOption}')"><span class="font-bold mr-3 text-slate-400">\${String.fromCharCode(65 + optIndex)}.</span> \${option}\${isSubmitted && option === q.answer ? '<span class="ml-2 text-green-600 font-bold">✓</span>' : ''}</div>\`;
                }).join('');
                return \`<div class="mb-10 p-8 bg-white rounded-2xl border border-gray-100 shadow-sm"><p class="text-xl font-bold text-slate-900 mb-6">Q\${index + 1}: \${q.q}</p>\${optionsHTML}</div>\`;
            }).join('');
            const resultHTML = result ? \`<div class="text-center p-10 bg-blue-600 text-white rounded-3xl mb-10 shadow-2xl"><h3 class="text-3xl font-black mb-2">測驗得分</h3><p class="text-6xl font-black">\${result.score} / \${result.total}</p><button class="mt-6 px-6 py-2 bg-white text-blue-600 font-bold rounded-full" onclick="initQuiz(true)">🔄 重新測驗</button></div>\` : '';
            return \`<h2 class="text-3xl font-extrabold text-slate-900 mb-8">內容測驗</h2>\${resultHTML}<div id="quiz-questions">\${questionsHTML}</div><div class="mt-12 text-center">\${result === undefined ? \`<button id="submit-quiz-button" class="w-full sm:w-auto px-12 py-4 bg-red-600 text-white text-xl font-black rounded-2xl shadow-xl hover:bg-red-700 transition disabled:opacity-30" onclick="submitQuizAnswer('\${topicId}')" disabled>送出答案並查看結果</button>\` : ''}<p id="quiz-message" class="mt-4 text-slate-400"></p></div>\`;
        }

        function initQuiz(forceReset = false) {
            const topicId = currentTopicId;
            if (forceReset || currentSubTab !== 'quiz') {
                quizState[topicId] = {};
                quizResult[topicId] = undefined;
                currentSubTab = 'quiz';
            }
            renderContent();
        }

        function selectOption(topicId, questionIndex, selectedOption) {
            if (quizResult[topicId] !== undefined) return;
            quizState[topicId] = quizState[topicId] || {};
            quizState[topicId][questionIndex] = selectedOption;
            updateQuizDisplay(topicId, NEWS_DATA[topicId].quiz);
        }

        function submitQuizAnswer(topicId) {
            const questions = NEWS_DATA[topicId].quiz;
            const answers = quizState[topicId] || {};
            let score = 0;
            questions.forEach((q, index) => { if (answers[index] === q.answer) score++; });
            quizResult[topicId] = { score, total: questions.length };
            renderContent();
        }

        function updateQuizDisplay(topicId, quizQuestions) {
            const currentQuizState = quizState[topicId] || {};
            const result = quizResult[topicId];
            const answeredCount = Object.keys(currentQuizState).length;
            const submitButton = document.getElementById('submit-quiz-button');
            const quizMessage = document.getElementById('quiz-message');
            if (submitButton) {
                submitButton.disabled = answeredCount !== quizQuestions.length;
                quizMessage.textContent = answeredCount === quizQuestions.length ? '所有題目已作答完畢' : \`已作答：\${answeredCount} / \${quizQuestions.length}\`;
            }
            if (result === undefined) {
                document.querySelectorAll('.quiz-option').forEach(el => {
                    const qIdxText = el.closest('.mb-10').querySelector('p').innerText;
                    const qIdx = parseInt(qIdxText.match(/Q(\d+):/)[1]) - 1;
                    const optValue = el.innerText.substring(3).replace('✓', '').trim();
                    el.classList.remove('selected');
                    if (currentQuizState[qIdx] === optValue) el.classList.add('selected');
                });
            }
        }

        function changeTopic(id) { currentTopicId = id; currentSubTab = 'article'; renderTabs(); renderContent(); }
        function changeSubTab(tab) { currentSubTab = tab; renderContent(); }

        window.onload = () => {
            renderTabs();
            renderContent();
        };
    </script>
</body>
</html>`;

  return beforeTemplate + 
    '\n        // --- DATA STRUCTURE ---\n' +
    '        const NEWS_DATA = ' + JSON.stringify(newsDataObj, null, 2) + ';' + 
    '\n\n        // --- CORE UI LOGIC ---' + afterTemplate;
}


// ── Step 4: Gemini 封面圖片 ───────────────────────────────────────────────────
async function generateCoverImage(coverNews, dates) {
  printHeader(4, '跳過自動產圖 (改為全手動上傳)');
  info(`✅ 本次將不消耗任何 API 來產生圖片`);
  info(`👉 系統即將直接上傳 HTML 網頁...`);
  info(`📌 【重要提醒】：請稍後手動去 Gemini 網頁畫好圖片，然後丟到 GitHub 的 covers/ 資料夾內！`);
  info(`📌 圖片檔名請務必命名為：news_${dates.plainDate}.jpg  (例如：news_20260329.jpg)`);
  
  // 直接回傳 null，如此一來 GitHub push 步驟就會自動略過圖片的上傳
  return null;
}

// ── Step 4.5: 更新 index.html ─────────────────────────────────────────────────
async function fetchCurrentIndex() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超時保護
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/index.html`,
    { 
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
      signal: controller.signal
    }
  );
  clearTimeout(timeoutId);
  const data = await res.json();
  if (!data.content) throw new Error('無法取得 index.html: ' + JSON.stringify(data));
  return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha };
}

function updateIndexHTML(indexContent, selection, dates) {
  const { coverNews } = selection;
  const marqueeEntry = `<a href="News/${dates.dotDate}英文新聞.html" class="marquee-item">${coverNews.zh}</a><span class="marquee-separator">•</span>\n                         `;

  let updated = indexContent.replace(
    /(<div class="flex shrink-0">)\s*\n(\s*<a href="News\/)/g,
    `$1\n                         ${marqueeEntry}$2`
  );

  updated = updated.replace(
    /(<span id="last-updated" class="text-lime-500 font-bold">)[^<]*/,
    `$1${dates.year}-${dates.month}-${dates.day}`
  );

  const card = `
                        <li data-date="${dates.slashDate}" data-month="${dates.dashMonth}">
                            <a href="News/${dates.dotDate}英文新聞.html" class="grid-card group block">
                                <div class="aspect-video relative overflow-hidden"><img src="covers/news_${dates.plainDate}.jpg" class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" onerror="this.src='https://placehold.co/600x400/1e293b/84cc16?text=NEWS'"></div>
                                <div class="p-6 flex flex-col justify-between flex-grow">
                                    <h3 class="text-white font-bold text-lg mb-4 line-clamp-2">${coverNews.zh}</h3>
                                    <div class="flex items-center justify-between text-gray-400 text-xs font-black tracking-widest mt-auto"><span>${dates.display}</span><span class="text-lime-500 bg-lime-500/10 px-2 py-1 rounded-md">Open</span></div>
                                </div>
                            </a>
                        </li>`;

  updated = updated.replace(/(<ul id="document-list"[^>]*>)/, `$1${card}`);
  return updated;
}

// ── Step 5: GitHub 推送 ───────────────────────────────────────────────────────
async function pushToGitHub(files) {
  printHeader(5, 'GitHub 推送');
  for (const file of files) {
    info(`上傳: ${file.path}`);
    let sha;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超時保護
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${file.path}`,
        { 
          headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
          signal: controller.signal
        }
      );
      clearTimeout(timeoutId);
      if (r.ok) sha = (await r.json()).sha;
    } catch {}

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超時保護
    const r = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(file.path)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: file.message || `Update ${file.path}`,
          content: file.content,
          ...(sha ? { sha } : {})
        }),
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);
    r.ok ? ok(file.path) : warn(`失敗 ${file.path}: ${(await r.json()).message}`);
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── 主程式 ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n========================================');
  console.log('  Daily English News Automation');
  console.log('  東旭每日英文新聞 x Telegram x Gemini');
  console.log(`  ${new Date().toLocaleString('zh-TW')}`);
  console.log('========================================');

  const nowDay = new Date().getDay();
  if (nowDay === 0 || nowDay === 6) {
    console.log('\n🏖️ 今天是節假日（週末），新聞系統自動休息不發報。');
    return;
  }

  const missing = ['GEMINI_API_KEY','GITHUB_TOKEN','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`\n缺少環境變數: ${missing.join(', ')}`);
    process.exit(1);
  }

  const dates = getTodayStrings();
  info(`今日: ${dates.dotDate}`);

  try {
    // 1. 產生新聞
    const news = await generateNews(dates);

    // 2. Telegram 選新聞
    await tgSend(`🚀 <b>每日英文新聞啟動</b>\n📅 ${dates.display}\n\n正在搜尋今日新聞，請稍候...`);
    const selection = await selectNewsViaTelegram(news, dates);

    // 3. 產生 HTML (改為逐次機制，由內部接管 tgSend)
    const articles = await generateNewsHTML(selection, dates);
    const newsHTML  = buildNewsHTML(articles, dates, selection);

    // 4. 封面圖
    await tgSend('🖼️ 正在生成封面圖片...');
    const cover = await generateCoverImage(selection.coverNews, dates);

    // 4.5 更新 index
    printHeader('4.5', '更新 index.html');
    const { content: idxContent } = await fetchCurrentIndex();
    const updatedIdx = updateIndexHTML(idxContent, selection, dates);
    ok('index.html 更新完成');

    // 4.6 寫入歷史紀錄防止重複
    try {
      let history = [];
      if (fs.existsSync('./history.json')) {
        history = JSON.parse(fs.readFileSync('./history.json', 'utf8'));
      }
      const newTitles = selection.allSelected.map(n => n.zh);
      history = [...history, ...newTitles].slice(-35); // Keep last 5 days
      fs.writeFileSync('./history.json', JSON.stringify(history, null, 2), 'utf8');
      ok('已更新 history.json (防止未來重複)');
    } catch(err) {
      warn('無法儲存 history.json: ' + err.message);
    }

    // 5. 推送
    await tgSend('🚀 正在推送到 GitHub...');
    const files = [
      {
        path: `News/${dates.dotDate}英文新聞.html`,
        content: Buffer.from(newsHTML, 'utf-8').toString('base64'),
        message: `Add news ${dates.dotDate}: ${selection.coverNews.zh}`
      },
      {
        path: 'index.html',
        content: Buffer.from(updatedIdx, 'utf-8').toString('base64'),
        message: `Update index ${dates.dotDate}`
      }
    ];
    if (cover) {
      files.splice(1, 0, {
        path: `covers/${cover.filename}`,
        content: cover.base64,
        message: `Add cover ${dates.dotDate}`
      });
    }
    if (fs.existsSync('./history.json')) {
      files.push({
        path: 'automation/history.json',
        content: Buffer.from(fs.readFileSync('./history.json', 'utf-8')).toString('base64'),
        message: 'chore: update news history [skip ci]'
      });
    }

    await pushToGitHub(files);

    await tgSend(
      `🎉 <b>今日更新完成！</b>\n\n` +
      `🖼️ ${selection.coverNews.zh}\n` +
      `📅 ${dates.display}\n\n` +
      `🔗 <a href="https://shiu47.github.io/Daily-English/">立即查看</a>`
    );

    console.log('\n========================================');
    console.log('  完成！');
    console.log(`  https://shiu47.github.io/Daily-English/`);
    console.log('========================================\n');

  } catch (err) {
    await tgSend(`❌ 錯誤: ${err.message}`).catch(() => {});
    console.error('\n錯誤:', err.message, '\n', err.stack);
    process.exit(1);
  }
}

main();
