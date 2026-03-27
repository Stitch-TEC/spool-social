import { PLATFORMS, STATUS, APPROVAL_STATUS } from '../constants';

/**
 * Converts an array of post objects into a CSV string.
 * Handles escaping quotes and wrapping fields that contain commas or newlines.
 */
export const convertToCSV = (posts) => {
  const headers = ['id', 'client', 'platform', 'content', 'status', 'approvalStatus', 'scheduledDate', 'createdAt', 'feedback', 'imageUrl'];
  const rows = posts.map(post => {
    return headers.map(header => {
      let value = post[header] || '';
      if (value instanceof Date) {
        value = value.toISOString();
      }

      const stringValue = String(value);
      // Escape double quotes by doubling them
      const escapedValue = stringValue.replace(/"/g, '""');

      // Wrap in quotes if it contains a comma, newline, or a quote
      if (/[,\n"]/.test(stringValue)) {
        return `"${escapedValue}"`;
      }
      return stringValue;
    }).join(',');
  });

  return [headers.join(','), ...rows].join('\n');
};

/**
 * A robust CSV parser that handles:
 * 1. Quoted fields containing commas
 * 2. Quoted fields containing newlines
 * 3. Escaped double quotes ("")
 */
export const parseCSV = (csvText) => {
  const result = [];
  let currentField = '';
  let currentRow = [];
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        // Escaped quote: "" becomes "
        currentField += '"';
        i++; // skip next quote
      } else if (char === '"') {
        // Closing quote
        inQuotes = false;
      } else {
        // Any other character inside quotes
        currentField += char;
      }
    } else {
      if (char === '"') {
        // Opening quote
        inQuotes = true;
      } else if (char === ',') {
        // Field separator
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\n' || char === '\r') {
        // Row separator (handle \r\n as well)
        currentRow.push(currentField.trim());
        if (currentRow.length > 0 && (currentRow.length > 1 || currentRow[0] !== '')) {
            result.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        if (char === '\r' && nextChar === '\n') {
          i++; // skip \n in \r\n
        }
      } else {
        // Regular character
        currentField += char;
      }
    }
  }

  // Handle last field if it exists
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    result.push(currentRow);
  }

  if (result.length < 2) return [];

  const headers = result[0].map(h => h.replace(/^"|"$/g, ''));
  const posts = [];

  for (let i = 1; i < result.length; i++) {
    const row = result[i];
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue;

    const post = {};
    headers.forEach((header, index) => {
      post[header] = row[index] || '';
    });

    // Basic Validation & Field Mapping
    if (!post.content || !post.client) continue;

    // Ensure platform is valid
    if (!PLATFORMS[post.platform]) {
      post.platform = 'gmb'; // Default
    }

    // Ensure status is valid
    if (!Object.values(STATUS).includes(post.status)) {
      post.status = STATUS.DRAFT;
    }

    // Ensure approvalStatus is valid
    if (!Object.values(APPROVAL_STATUS).includes(post.approvalStatus)) {
      post.approvalStatus = APPROVAL_STATUS.PENDING;
    }

    // Date parsing
    if (post.scheduledDate) {
      const d = new Date(post.scheduledDate);
      if (!isNaN(d.getTime())) {
        post.scheduledDate = d.toISOString();
      } else {
        post.scheduledDate = null;
      }
    }

    posts.push(post);
  }

  return posts;
};

/**
 * Triggers a browser download of a CSV file.
 */
export const downloadCSV = (csvText, filename) => {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
