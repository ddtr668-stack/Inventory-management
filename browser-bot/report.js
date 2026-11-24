(() => {
  'use strict';

  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const list = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const first = selector => list(selector)[0];
  const idle = selector => list(selector).find(element => !element.matches(':disabled, [aria-disabled=true]'));
  const text = element => element.textContent.trim().replace(/\s+/g, ' ');

  async function wait(get, description, timeout = 20_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const element = get();
      if (element) return element;
      await delay(200);
    }
    throw new Error(description + '을(를) 찾지 못했습니다. 이카운트 로그인과 조회 권한을 확인해 주세요.');
  }

  async function click(selector, description, timeout) {
    const element = await wait(() => idle(selector), description, timeout);
    element.click();
    return element;
  }

  async function pick(button, label) {
    button.click();
    const matches = () => list('li > a').find(element => text(element) === label);
    (await wait(matches, label, 5_000)).click();
    await delay(300);
  }

  function control(cid) {
    return 'button[data-cid="' + cid + '"][data-role="date.selectbox"]';
  }

  async function openSearch(cid) {
    await wait(() => idle('#tgHeaderSearch') || first(control(cid)), '검색 조건');
    if (!first(control(cid))) await click('#tgHeaderSearch', '검색 조건 열기');
    await wait(() => first(control(cid)), '기준일 입력');
  }

  async function setDate(cid, index, value) {
    const [year, month, day] = value.split('-');
    const buttons = () => list(control(cid));
    await pick(await wait(() => buttons()[index * 2], '연도 선택'), year);
    await pick(await wait(() => buttons()[index * 2 + 1], '월 선택'), Number(month) + '월');
    const field = await wait(() => list('input.form-control[data-cid="' + cid + '"]')[index], '일 입력');
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, day);
    field.dispatchEvent(new Event('input', {bubbles: true}));
    field.dispatchEvent(new Event('change', {bubbles: true}));
    field.blur();
    if (Number(field.value) !== Number(day)) throw new Error('이카운트에서 기준일을 선택하지 못했습니다.');
  }

  async function setWarehouse(warehouse) {
    const activeDialog = () => list('.ui-dialog').at(-1);
    const close = () => list('button', activeDialog() || document).find(element => text(element) === '닫기');
    if (activeDialog()) {
      (await wait(close, '열려 있는 팝업의 닫기')).click();
      await wait(() => !activeDialog(), '검색 조건 화면', 5_000);
    }
    const remove = 'button.tag-remove[data-cid="txtSWhCd"]';
    for (let i = 0; i < 20 && first(remove); i++) {
      first(remove).click();
      await delay(200);
    }
    if (first(remove)) throw new Error('이전 창고 검색 조건을 지우지 못했습니다.');
    if (!warehouse) return;
    await click('button.btn-code-search[data-cid="txtSWhCd"]', '창고 검색');
    const match = () => activeDialog() && list('a', activeDialog()).find(element =>
      text(element).replaceAll(' ', '') === warehouse.replaceAll(' ', ''));
    const selected = () => list('span.tag:has([data-cid="txtSWhCd"])').length;
    for (let i = 0; i < 6 && !selected(); i++) {
      (await wait(match, '창고 ' + warehouse, 15_000)).click();
      await delay(450);
    }
    if (!selected()) throw new Error(warehouse + '를 선택하지 못했습니다.');
    if (activeDialog()) (await wait(close, '창고 검색 닫기')).click();
  }

  globalThis.sgEcountReport = async (action, report) => {
    try {
      const isStock = report.kind === 'stock';
      const cid = isStock ? 'ddlSYear_DATE' : 'ddlSYear';
      const excel = isStock ? '#outputExcel' : '#excel';
      if (action === 'prepare') {
        await openSearch(cid);
        if (!isStock) await setWarehouse(report.warehouse);
        await setDate(cid, 0, report.start);
        if (!isStock) await setDate(cid, 1, report.end);
        await click(isStock ? '#searchGroup' : '#search', '조회');
        await delay(isStock ? 4_000 : 3_000);
        await wait(() => idle(excel), '엑셀 출력', 60_000);
      } else if (action === 'export') {
        await click(excel, '엑셀 출력');
      } else {
        throw new Error('지원하지 않는 재고 조회입니다.');
      }
      return {ok: true};
    } catch (error) {
      return {error: error.message};
    }
  };
})();
