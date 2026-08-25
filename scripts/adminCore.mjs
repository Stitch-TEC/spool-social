export const CLIENT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function validateFirestoreValue(value, context) {
  if (!isObject(value)) throw new Error(`${context} returned a malformed typed field`);
  const variants = [
    'nullValue', 'booleanValue', 'integerValue', 'doubleValue', 'timestampValue',
    'stringValue', 'bytesValue', 'referenceValue', 'geoPointValue', 'arrayValue', 'mapValue',
  ].filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (variants.length !== 1 || Object.keys(value).length !== 1) {
    throw new Error(`${context} returned an unknown/ambiguous typed field`);
  }
  const kind = variants[0];
  const payload = value[kind];
  if (kind === 'nullValue' && payload !== null && payload !== 'NULL_VALUE') throw new Error(`${context} returned malformed nullValue`);
  if (kind === 'booleanValue' && typeof payload !== 'boolean') throw new Error(`${context} returned malformed booleanValue`);
  if (kind === 'integerValue' && (typeof payload !== 'string' || !/^-?\d+$/.test(payload))) throw new Error(`${context} returned malformed integerValue`);
  if (kind === 'doubleValue' && typeof payload !== 'number' && !['NaN', 'Infinity', '-Infinity'].includes(payload)) {
    throw new Error(`${context} returned malformed doubleValue`);
  }
  if (['timestampValue', 'stringValue', 'bytesValue', 'referenceValue'].includes(kind) && typeof payload !== 'string') {
    throw new Error(`${context} returned malformed ${kind}`);
  }
  if (kind === 'geoPointValue' && (!isObject(payload)
    || Object.keys(payload).some((key) => !['latitude', 'longitude'].includes(key))
    || typeof payload.latitude !== 'number' || typeof payload.longitude !== 'number')) {
    throw new Error(`${context} returned malformed geoPointValue`);
  }
  if (kind === 'arrayValue') {
    if (!isObject(payload)
      || Object.keys(payload).some((key) => key !== 'values')
      || (payload.values !== undefined && !Array.isArray(payload.values))) {
      throw new Error(`${context} returned malformed arrayValue`);
    }
    for (const item of payload.values || []) validateFirestoreValue(item, context);
  }
  if (kind === 'mapValue') {
    if (!isObject(payload)
      || Object.keys(payload).some((key) => key !== 'fields')
      || (payload.fields !== undefined && !isObject(payload.fields))) {
      throw new Error(`${context} returned malformed mapValue`);
    }
    for (const nested of Object.values(payload.fields || {})) validateFirestoreValue(nested, context);
  }
}
export const fieldString = (row, field) => {
  const value = row?.fields?.[field];
  return isObject(value) && typeof value.stringValue === 'string' ? value.stringValue : undefined;
};

export async function requestJsonObject({ fetchImpl, url, init, context = 'Request' }) {
  let response;
  try { response = await fetchImpl(url, init); }
  catch (error) { throw new Error(`${context} failed: ${error?.message || error}`); }

  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${context} returned invalid JSON`); }
  if (!isObject(data)) throw new Error(`${context} returned a non-object JSON payload`);
  if (response.status === 404) return { _status: 404 };
  if (!response.ok) {
    const message = data?.error?.message;
    throw new Error(typeof message === 'string' && message ? message : `${context} failed (${response.status})`);
  }
  return data;
}

export function parseCollectionPage(data, collection) {
  if (!isObject(data)) throw new Error(`Collection inventory failed: ${collection} returned a non-object payload`);
  if (Object.keys(data).some((key) => !['documents', 'nextPageToken'].includes(key))) {
    throw new Error(`Collection inventory failed: ${collection} returned an unknown response field`);
  }
  const hasDocuments = Object.prototype.hasOwnProperty.call(data, 'documents');
  // Firestore ListDocuments represents a successfully empty collection as the
  // canonical empty object. Accept ONLY that exact shape. Any populated shape
  // missing `documents` is malformed/partial and remains a stop condition.
  if (!hasDocuments && Object.keys(data).length === 0) return { rows: [], nextPageToken: '' };
  if (!hasDocuments || !Array.isArray(data.documents)) {
    throw new Error(`Collection inventory failed: ${collection} returned a missing/malformed documents array`);
  }
  if (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string') {
    throw new Error(`Collection inventory failed: ${collection} returned a malformed page token`);
  }
  const rows = data.documents.map((document) => {
    if (!isObject(document)
      || Object.keys(document).some((key) => !['name', 'fields', 'createTime', 'updateTime'].includes(key))
      || typeof document.name !== 'string'
      || !document.name) {
      throw new Error(`Collection inventory failed: ${collection} returned a malformed document`);
    }
    const segments = document.name.split('/');
    const documentId = segments[6] || '';
    if (
      segments.length !== 7
      || segments[0] !== 'projects'
      || !segments[1]
      || segments[2] !== 'databases'
      || !segments[3]
      || segments[4] !== 'documents'
      || segments[5] !== collection
      || !documentId
    ) {
      throw new Error(`Collection inventory failed: ${collection} returned a malformed document resource name`);
    }
    if (document.fields !== undefined && !isObject(document.fields)) {
      throw new Error(`Collection inventory failed: ${collection} returned malformed document fields`);
    }
    for (const value of Object.values(document.fields || {})) {
      validateFirestoreValue(value, `Collection inventory failed: ${collection}`);
    }
    if (typeof document.updateTime !== 'string' || !document.updateTime) {
      throw new Error(`Collection inventory failed: ${collection} returned a malformed document updateTime`);
    }
    if (document.createTime !== undefined && (typeof document.createTime !== 'string' || !document.createTime)) {
      throw new Error(`Collection inventory failed: ${collection} returned a malformed document createTime`);
    }
    return {
      name: document.name,
      id: documentId,
      fields: document.fields || {},
      updateTime: document.updateTime,
    };
  });
  return { rows, nextPageToken: data.nextPageToken || '' };
}

export async function listAllDocuments({ collection, fields, fetchPage }) {
  const rows = [];
  let pageToken = '';
  const seenPageTokens = new Set();
  do {
    const params = new URLSearchParams({ pageSize: '300' });
    if (pageToken) params.set('pageToken', pageToken);
    for (const field of fields) params.append('mask.fieldPaths', field);
    const data = await fetchPage(`${collection}?${params}`);
    if (data?._status === 404) throw new Error(`Collection inventory failed: ${collection} returned 404`);
    const page = parseCollectionPage(data, collection);
    rows.push(...page.rows);
    pageToken = page.nextPageToken;
    if (pageToken && seenPageTokens.has(pageToken)) {
      throw new Error(`Collection inventory failed: ${collection} repeated a page token`);
    }
    if (pageToken) seenPageTokens.add(pageToken);
  } while (pageToken);
  return rows;
}

export function parseRosterSnapshot(raw) {
  if (!isObject(raw) && !Array.isArray(raw)) throw new Error('Roster payload must be an object or array');
  const source = Array.isArray(raw) ? raw : raw.clients;
  if (!Array.isArray(source) || !source.length) throw new Error('Roster is empty or missing clients');
  const rows = source.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`Roster row ${index + 1} is not an object`);
    if (typeof entry.slug !== 'string' || !entry.slug || entry.slug.length > 64 || !CLIENT_ID_RE.test(entry.slug)) {
      throw new Error(`Roster row ${index + 1} has an invalid canonical slug`);
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error(`Roster row ${index + 1} has an invalid name`);
    }
    return { slug: entry.slug, name: entry.name.trim() };
  });
  const slugSet = new Set();
  const nameSet = new Set();
  for (const row of rows) {
    const nameKey = normalizeClientName(row.name);
    if (slugSet.has(row.slug)) throw new Error(`Roster repeats canonical slug ${row.slug}`);
    if (nameSet.has(nameKey)) throw new Error(`Roster repeats canonical client name ${JSON.stringify(row.name)}`);
    slugSet.add(row.slug);
    nameSet.add(nameKey);
  }
  return rows;
}

export const normalizeClientName = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function classifyPostRows(posts) {
  const malformedSources = posts.filter((post) => (
    Object.prototype.hasOwnProperty.call(post.fields || {}, 'source')
    && fieldString(post, 'source') === undefined
  ));
  const malformed = new Set(malformedSources);
  const suggestions = posts.filter((post) => fieldString(post, 'source') === 'suggestion');
  return {
    malformedSources,
    suggestions,
    ordinaryPosts: posts.filter((post) => !malformed.has(post) && fieldString(post, 'source') !== 'suggestion'),
    unsafeSuggestionTenants: suggestions.filter((post) => fieldString(post, 'clientId') !== ''),
  };
}

/** Build the legacy slugified-name repair map and refuse ambiguous canonical
 * roster names (for example "A&B" and "A B" both slugifying to `a-b`). */
export function buildRosterRepairMap(roster, slugify) {
  const map = new Map();
  for (const client of roster) {
    const key = slugify(client.name);
    if (!key) throw new Error(`Roster client ${JSON.stringify(client.name)} has no repair name key`);
    const prior = map.get(key);
    if (prior && prior !== client.slug) {
      throw new Error(`Roster repair-name collision: ${JSON.stringify(client.name)} and another client both map to ${key}`);
    }
    map.set(key, client.slug);
  }
  return map;
}

export function stringClaimAudit(rows, field, expected) {
  return {
    missing: rows.filter((row) => !Object.prototype.hasOwnProperty.call(row.fields || {}, field)),
    nonString: rows.filter((row) => Object.prototype.hasOwnProperty.call(row.fields || {}, field) && fieldString(row, field) === undefined),
    wrong: rows.filter((row) => {
      const value = fieldString(row, field);
      return value !== undefined && expected !== undefined && value !== expected;
    }),
  };
}

export function rosterClaimAudit(rows, field, rosterIds) {
  return {
    missing: rows.filter((row) => !Object.prototype.hasOwnProperty.call(row.fields || {}, field)),
    nonString: rows.filter((row) => Object.prototype.hasOwnProperty.call(row.fields || {}, field) && fieldString(row, field) === undefined),
    invalid: rows.filter((row) => {
      const value = fieldString(row, field);
      return value !== undefined && (!value || value.length > 64 || !CLIENT_ID_RE.test(value));
    }),
    offRoster: rows.filter((row) => {
      const value = fieldString(row, field);
      return value !== undefined && value && CLIENT_ID_RE.test(value) && !rosterIds.has(value);
    }),
  };
}

export function rosterNameClaimAudit(rows, field, rosterNames) {
  return {
    missing: rows.filter((row) => !Object.prototype.hasOwnProperty.call(row.fields || {}, field)),
    nonString: rows.filter((row) => Object.prototype.hasOwnProperty.call(row.fields || {}, field) && fieldString(row, field) === undefined),
    invalid: rows.filter((row) => {
      const value = fieldString(row, field);
      return value !== undefined && !normalizeClientName(value);
    }),
    offRoster: rows.filter((row) => {
      const value = fieldString(row, field);
      const normalized = normalizeClientName(value);
      return !!normalized && !rosterNames.has(normalized);
    }),
  };
}

function mappingConflicts(claims, roster) {
  const idsToNames = new Map();
  const namesToIds = new Map();
  const rosterClientById = new Map(roster.map((client) => [client.slug, client]));
  const rosterIdByName = new Map(roster.map((client) => [normalizeClientName(client.name), client.slug]));
  const rosterMismatches = [];
  for (const claim of claims) {
    const id = fieldString(claim.row, claim.idField);
    const name = fieldString(claim.row, claim.nameField);
    const nameKey = normalizeClientName(name);
    if (!id || !nameKey) continue;
    if (!idsToNames.has(id)) idsToNames.set(id, new Map());
    idsToNames.get(id).set(nameKey, name);
    if (!namesToIds.has(nameKey)) namesToIds.set(nameKey, { name, ids: new Set() });
    namesToIds.get(nameKey).ids.add(id);
    const rosterClient = rosterClientById.get(id);
    if (rosterClient && (
      normalizeClientName(rosterClient.name) !== nameKey
      || (rosterIdByName.has(nameKey) && rosterIdByName.get(nameKey) !== id)
    )) rosterMismatches.push({
      row: claim.row,
      kind: claim.kind,
      id,
      name,
      expectedName: rosterClient.name,
    });
  }
  return {
    idToMultipleNames: [...idsToNames.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([id, names]) => ({ id, names: [...names.values()] })),
    nameToMultipleIds: [...namesToIds.values()]
      .filter(({ ids }) => ids.size > 1)
      .map(({ name, ids }) => ({ name, ids: [...ids] })),
    rosterMismatches,
  };
}

export function auditWorkspace({ posts, clients, automations, shares, roster, ownerUid }) {
  const rosterIds = new Set(roster.map((client) => client.slug));
  const rosterNames = new Set(roster.map((client) => normalizeClientName(client.name)));
  const ordinaryPosts = posts.filter((row) => fieldString(row, 'source') !== 'suggestion');
  const suggestions = posts.filter((row) => fieldString(row, 'source') === 'suggestion');
  const postUids = stringClaimAudit(posts, 'uid', ownerUid);
  const malformedSources = posts.filter((row) => (
    Object.prototype.hasOwnProperty.call(row.fields || {}, 'source')
    && fieldString(row, 'source') === undefined
  ));
  const suggestionClientId = {
    invalid: suggestions.filter((row) => fieldString(row, 'clientId') !== ''),
  };
  const suggestionStage = {
    invalid: suggestions.filter((row) => fieldString(row, 'reviewStage') !== 'private'),
  };
  const claims = {
    ordinaryPosts: rosterClaimAudit(ordinaryPosts, 'clientId', rosterIds),
    suggestions: rosterClaimAudit(suggestions, 'forClientId', rosterIds),
    clients: rosterClaimAudit(clients, 'clientId', rosterIds),
    automations: rosterClaimAudit(automations, 'clientId', rosterIds),
    shares: rosterClaimAudit(shares, 'clientId', rosterIds),
  };
  const names = {
    ordinaryPosts: rosterNameClaimAudit(ordinaryPosts, 'client', rosterNames),
    suggestions: rosterNameClaimAudit(suggestions, 'client', rosterNames),
    clients: rosterNameClaimAudit(clients, 'name', rosterNames),
    automations: rosterNameClaimAudit(automations, 'client', rosterNames),
    shares: rosterNameClaimAudit(shares, 'client', rosterNames),
  };
  const mappings = mappingConflicts([
    ...ordinaryPosts.map((row) => ({ row, kind: 'post', idField: 'clientId', nameField: 'client' })),
    ...suggestions.map((row) => ({ row, kind: 'suggestion', idField: 'forClientId', nameField: 'client' })),
    ...clients.map((row) => ({ row, kind: 'client', idField: 'clientId', nameField: 'name' })),
    ...automations.map((row) => ({ row, kind: 'automation', idField: 'clientId', nameField: 'client' })),
    ...shares.map((row) => ({ row, kind: 'share', idField: 'clientId', nameField: 'client' })),
  ], roster);
  const badReviewStage = ordinaryPosts.filter((row) => !['private', 'in_review'].includes(fieldString(row, 'reviewStage')));
  return {
    ordinaryPosts,
    suggestions,
    postUids,
    malformedSources,
    suggestionClientId,
    suggestionStage,
    claims,
    names,
    mappings,
    badReviewStage,
  };
}

export function reviewStageBackfillPlan(posts) {
  const malformedSources = posts.filter((row) => (
    Object.prototype.hasOwnProperty.call(row.fields || {}, 'source')
    && fieldString(row, 'source') === undefined
  ));
  const malformedSourceSet = new Set(malformedSources);
  const invalid = posts.filter((row) => {
    const value = fieldString(row, 'reviewStage');
    return row.fields.reviewStage !== undefined && !['private', 'in_review'].includes(value);
  });
  const changes = posts
    .filter((row) => row.fields.reviewStage === undefined && !malformedSourceSet.has(row))
    .map((row) => ({ row, value: fieldString(row, 'source') === 'suggestion' ? 'private' : 'in_review' }));
  const unsafeSuggestions = posts.filter((row) => (
    fieldString(row, 'source') === 'suggestion'
    && row.fields.reviewStage !== undefined
    && fieldString(row, 'reviewStage') !== 'private'
  ));
  return { invalid, changes, unsafeSuggestions, malformedSources };
}
