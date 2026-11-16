// org-policy.js — P0-T02 org_policy 服务
// 策略改动即时生效:内存缓存 + 写入即失效,无需重启。
// 所有策略读写统一走本模块,禁止业务代码直接 SELECT org_policy。

const cache = new Map();   // key -> value (字符串),空表示未缓存

/**
 * 读策略。优先内存缓存;未命中则查库并缓存。
 * @param {object} db  数据库
 * @param {string} key 策略键
 * @param {string} [def='false'] 默认值(键不存在时返回)
 */
function getPolicy(db, key, def = 'false') {
  if (cache.has(key)) return cache.get(key);
  const row = db.prepare('SELECT value FROM org_policy WHERE key = ?').get(key);
  const val = row ? row.value : def;
  cache.set(key, val);
  return val;
}

/**
 * 写策略。UPSERT 后立即清除该键缓存 → 下次读重新查库,即时生效。
 * @param {object} db
 * @param {string} key
 * @param {string} value
 * @returns {{key, value, updated: boolean}}
 */
function setPolicy(db, key, value) {
  const val = String(value);
  db.prepare(
    `INSERT INTO org_policy(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, val);
  cache.delete(key);   // 失效缓存,下次 getPolicy 重新查库
  return { key, value: val, updated: true };
}

/**
 * 列出全部策略(key/value)。不缓存(管理操作,低频)。
 */
function listPolicies(db) {
  return db.prepare('SELECT key, value FROM org_policy ORDER BY key').all();
}

/**
 * 清空缓存(测试/迁移后调用)。
 */
function clearCache() {
  cache.clear();
}

module.exports = { getPolicy, setPolicy, listPolicies, clearCache };
