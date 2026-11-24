'use strict';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byId = id => document.getElementById(id);
const authForm = byId('authenticate');
const staffForm = byId('add-staff');
const endpoint = 'https://api.github.com/repos/ddtr668-stack/Inventory-management/contents/data/keys.json';
const iterations = 600_000;
let authorization;

function status(message, error = false) {
  byId('status').textContent = message;
  byId('status').classList.toggle('error', error);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function accountHash(id) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode('sg-inv:' + id));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function passwordKey(password, salt, rounds, usage) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', hash:'SHA-256', salt, iterations:rounds},
    key, {name:'AES-GCM', length:256}, false, [usage]);
}

async function unlockAdmin(keys, password) {
  const hash = await accountHash('admin');
  const record = keys.users?.[hash];
  if (!record) throw new Error('관리자 계정을 확인하지 못했습니다.');
  const key = await passwordKey(password, fromBase64(record.salt), record.iter, 'decrypt');
  try {
    const dataKey = new Uint8Array(await crypto.subtle.decrypt(
      {name:'AES-GCM', iv:fromBase64(record.iv)}, key, fromBase64(record.key)));
    if (dataKey.length !== 32) throw new Error('invalid data key');
    return {hash, record, dataKey};
  } catch {
    throw new Error('관리자 비밀번호를 확인해 주세요.');
  }
}

async function createRecord(password, dataKey) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt, iterations, 'encrypt');
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, dataKey);
  return {salt:toBase64(salt), iter:iterations, iv:toBase64(iv), key:toBase64(new Uint8Array(encrypted))};
}

async function github(token, options = {}) {
  const response = await fetch(options.method === 'PUT' ? endpoint : endpoint + '?ref=main', {
    ...options, cache:'no-store', credentials:'omit', redirect:'error',
    headers:{Accept:'application/vnd.github+json', Authorization:'Bearer ' + token, 'Content-Type':'application/json'}
  });
  if (response.status === 409) throw new Error('다른 변경이 먼저 적용됐습니다. 다시 시도해 주세요.');
  if ([401,403,404].includes(response.status)) throw new Error('토큰 만료 여부와 저장소 Contents 읽기·쓰기 권한을 확인해 주세요.');
  if (!response.ok) throw new Error('GitHub에 계정 목록을 반영하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return response.json();
}

function lock() {
  authorization?.dataKey.fill(0);
  authorization = undefined;
  authForm.reset();
  staffForm.reset();
  authForm.hidden = false;
  staffForm.hidden = true;
}

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = authForm.querySelector('button');
  if (button.disabled) return;
  if (byId('administrator').value.trim().toLowerCase() !== 'admin') {
    status('기존 관리자 계정으로 로그인해 주세요.', true);
    return;
  }
  button.disabled = true;
  status('관리자 계정을 확인하는 중입니다.');
  try {
    const response = await fetch('data/keys.json', {cache:'no-store'});
    if (!response.ok) throw new Error('계정 목록을 불러오지 못했습니다.');
    authorization = await unlockAdmin(await response.json(), byId('admin-password').value);
    authForm.reset();
    authForm.hidden = true;
    staffForm.hidden = false;
    status('관리자 인증이 완료되었습니다.');
    byId('employee').focus();
  } catch (error) {
    status(error.message, true);
  } finally {
    byId('admin-password').value = '';
    button.disabled = false;
  }
});

staffForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = staffForm.querySelector('button');
  if (button.disabled || !authorization) return;
  const id = byId('employee').value.trim().toLowerCase();
  const password = byId('employee-password').value;
  const token = byId('repository-token').value.trim();
  if (!/^[a-z0-9._-]{3,20}$/.test(id) || id === 'admin') {
    status('직원 아이디를 확인해 주세요.', true);
    return;
  }
  if (password.length < 12 || password !== byId('employee-password-check').value) {
    status('12자 이상인 초기 비밀번호를 두 칸에 동일하게 입력해 주세요.', true);
    return;
  }
  if (!token.startsWith('github_pat_')) {
    status('세분화된 GitHub 액세스 토큰을 입력해 주세요.', true);
    return;
  }

  const verified = authorization;
  button.disabled = true;
  byId('repository-token').value = '';
  status('최신 계정 목록을 확인하고 있습니다.');
  try {
    const file = await github(token);
    if (file.encoding !== 'base64' || !file.sha) throw new Error('GitHub 계정 목록 형식을 확인해 주세요.');
    const keys = JSON.parse(decoder.decode(fromBase64(file.content)));
    const current = keys.users?.[verified.hash];
    if (!current || ['salt','iter','iv','key'].some(field => current[field] !== verified.record[field])) {
      lock();
      throw new Error('관리자 계정 정보가 변경됐습니다. 다시 인증해 주세요.');
    }
    const hash = await accountHash(id);
    if (Object.hasOwn(keys.users, hash)) throw new Error('이미 등록된 직원 아이디입니다.');
    keys.users[hash] = await createRecord(password, verified.dataKey);
    if (authorization !== verified) return;
    await github(token, {
      method:'PUT',
      body:JSON.stringify({
        message:'Add inventory viewer account',
        content:toBase64(encoder.encode(JSON.stringify(keys, null, 2) + '\n')),
        sha:file.sha,
        branch:'main'
      })
    });
    lock();
    status(id + ' 계정을 추가했습니다. 배포 후 재고관리 사이트에서 로그인할 수 있습니다.');
  } catch (error) {
    status(error.message, true);
  } finally {
    byId('employee-password').value = '';
    byId('employee-password-check').value = '';
    button.disabled = false;
  }
});

window.addEventListener('pagehide', lock);
