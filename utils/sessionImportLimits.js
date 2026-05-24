/** Shared limits for GitHub + local folder imports into sessions. */
const MAX_FILES = 120;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

module.exports = {
    MAX_FILES,
    MAX_FILE_BYTES,
    MAX_TOTAL_BYTES
};
