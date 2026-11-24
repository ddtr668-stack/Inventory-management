'use strict';

const siteOrigin = 'https://ddtr668-stack.github.io';
const sitePath = '/Inventory-management/';
const warehouses = ['배방창고', '익산창고', '임시순천향창고', '기타물류', '항목 서비스'];
const menus = {
  stock: '#menuType=MENUTREE_000004&menuSeq=MENUTREE_000212&groupSeq=MENUTREE_000035&prgId=E040701&depth=4',
  change: '#menuType=MENUTREE_000004&menuSeq=MENUTREE_001713&groupSeq=MENUTREE_000035&prgId=E040719&depth=4'
};
let activeJob;
let pendingDownload;

function erpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.ecount.com') &&
      /^\/view\/erp(?:\/|$)/i.test(parsed.pathname) ? parsed : null;
  } catch { return null; }
}

function makeReports(value) {
  const base = new Date(value + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+base) || base.toISOString().slice(0, 10) !== value) {
    throw new Error('기준일자를 다시 확인해 주세요.');
  }
  const next = new Date(+base);
  next.setUTCFullYear(base.getUTCFullYear() + 1);
  if (next.getUTCMonth() !== base.getUTCMonth()) next.setUTCDate(0);
  const stamp = value.replaceAll('-', '');
  const reports = [{ kind: 'stock', start: value, name: stamp + ' 재고현황.xlsx' }];
  for (const warehouse of ['', ...warehouses]) {
    for (const [label, end] of [['당일', value], ['1년', next.toISOString().slice(0, 10)]]) {
      const suffix = warehouse ? '_' + warehouse : '';
      reports.push({kind: 'change', start: value, end, warehouse, name: stamp + ' 재고변동표(' + label + ')' + suffix + '.xlsx'});
    }
  }
  return {stamp, reports};
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const pending = pendingDownload;
  if (!pending || pending.id !== undefined || item.incognito !== pending.incognito) {
    suggest();
    return;
  }
  try {
    const origins = [item.url, item.finalUrl, item.referrer].filter(Boolean).map(value => {
      try { return new URL(value).origin; } catch { return ''; }
    });
    if (!origins.includes(pending.origin) ||
        (!/\.xlsx$/i.test(item.filename || '') && !/spreadsheetml\.sheet/i.test(item.mime || ''))) {
      suggest();
      return;
    }
    suggest({filename: pending.filename, conflictAction: 'uniquify'});
    pending.id = item.id;
    pending.check();
  } catch (error) {
    pending.reject(error);
  }
});

chrome.downloads.onChanged.addListener(change => {
  const pending = pendingDownload;
  if (pending && change.id === pending.id && (change.state || change.error)) pending.check();
});

async function collectDownload(tab, filename, click) {
  let timer, pending;
  const completion = new Promise((resolve, reject) => {
    pending = {
      origin: erpUrl(tab.url).origin, incognito: Boolean(tab.incognito), filename, reject,
      async check() {
        try {
          const [item] = await chrome.downloads.search({id: pending.id});
          if (item?.state === 'interrupted') reject(new Error('엑셀 다운로드가 중단됐습니다.'));
          if (item?.state === 'complete') {
            const actual = item.filename.replaceAll('\\', '/').toLowerCase();
            if (!actual.endsWith('/' + filename.toLowerCase())) {
              reject(new Error('다운로드 경로가 변경됐습니다. 브라우저 다운로드 내역을 확인해 주세요.'));
            } else resolve();
          }
        } catch (error) { reject(error); }
      }
    };
    timer = setTimeout(() => reject(new Error('이카운트 엑셀을 받지 못했습니다. 탭과 브라우저 다운로드 설정을 확인해 주세요.')), 120_000);
  });
  pendingDownload = pending;
  try {
    await Promise.all([click(), completion]);
  } finally {
    clearTimeout(timer);
    pendingDownload = undefined;
  }
}

async function sendPage(tabId, action, report) {
  const [result] = await chrome.scripting.executeScript({
    target: {tabId}, func: (name, value) => globalThis.sgEcountReport(name, value), args: [action, report]
  });
  if (result?.error) throw new Error(result.error.message || String(result.error));
  if (result?.result?.error) throw new Error(result.result.error);
  if (result?.result?.ok !== true) throw new Error('이카운트 재고 화면에서 응답을 받지 못했습니다.');
}

async function run(port, value) {
  if (activeJob) {
    port.postMessage({type: 'error', message: '다른 재고 다운로드가 진행 중입니다.'});
    return;
  }
  const job = {port, cancelled: false};
  activeJob = job;
  const update = message => {
    if (!job.cancelled) {
      try { port.postMessage(message); }
      catch { job.cancelled = true; }
    }
  };
  try {
    const {stamp, reports} = makeReports(value);
    const incognito = Boolean(port.sender.tab?.incognito);
    const tabs = (await chrome.tabs.query({url: 'https://*.ecount.com/*'}))
      .filter(tab => Boolean(tab.incognito) === incognito && erpUrl(tab.url));
    if (tabs.length !== 1) {
      throw new Error(tabs.length ? '같은 브라우저에 이카운트 ERP 탭을 하나만 열어 주세요.' : '같은 브라우저에서 이카운트에 로그인하고 ERP 메인 화면을 열어 주세요.');
    }
    const [tab] = tabs;
    const source = erpUrl(tab.url);
    const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
    const folder = '이카운트_다운로드/' + stamp + '/' + runId;
    update({type: 'started', total: reports.length, folder});
    let lastKind, count = 0;
    for (const report of reports) {
      if (job.cancelled) return;
      const current = erpUrl((await chrome.tabs.get(tab.id)).url);
      if (current?.origin !== source.origin || current.pathname !== source.pathname) {
        throw new Error('이카운트 탭이 닫혔거나 로그인이 만료됐습니다.');
      }
      if (report.kind !== lastKind) {
        await chrome.scripting.executeScript({
          target: {tabId: tab.id}, func: hash => { location.hash = hash; }, args: [menus[report.kind]]
        });
        lastKind = report.kind;
      }
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['report.js']});
      update({type: 'progress', count, total: reports.length, name: report.name});
      await sendPage(tab.id, 'prepare', report);
      if (job.cancelled) return;
      await collectDownload(tab, folder + '/' + report.name, () => sendPage(tab.id, 'export', report));
      count++;
    }
    update({type: 'complete', count, folder});
  } catch (error) {
    update({type: 'error', message: error.message || '다운로드에 실패했습니다.'});
  } finally {
    activeJob = undefined;
  }
}

chrome.runtime.onConnectExternal.addListener(port => {
  const sender = port.sender;
  try {
    const url = new URL(sender?.url);
    if (port.name !== 'sg-ecount-browser' || url.origin !== siteOrigin ||
        ![sitePath, sitePath + 'index.html'].includes(url.pathname) || (sender.frameId ?? 0) !== 0) {
      port.disconnect();
      return;
    }
  } catch {
    port.disconnect();
    return;
  }
  port.onMessage.addListener(message => {
    if (message?.type === 'status') port.postMessage({type: 'ready', busy: Boolean(activeJob)});
    if (message?.type === 'download' && typeof message.date === 'string') void run(port, message.date);
    if (message?.type === 'download-settings') {
      const scheme = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
      chrome.tabs.create({url: scheme + '://settings/downloads'}).catch(() => {
        port.postMessage({type: 'error', message: '브라우저 설정에서 다운로드 위치를 열어 주세요.'});
      });
    }
  });
  port.onDisconnect.addListener(() => {
    if (activeJob?.port === port) {
      activeJob.cancelled = true;
      pendingDownload?.reject(new Error('재고관리 웹사이트 연결이 닫혔습니다.'));
    }
  });
});
