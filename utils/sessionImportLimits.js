/** Shared limits for GitHub + local folder imports into sessions. */
const MAX_FILES = 45;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

module.exports = {
    MAX_FILES,
    MAX_FILE_BYTES,
    MAX_TOTAL_BYTES
};
