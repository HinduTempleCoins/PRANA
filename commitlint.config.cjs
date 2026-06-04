// Commitlint configuration — enforces Conventional Commits across PRANA.
// Conventional Commits (type(scope): subject) is what release-please parses to
// decide version bumps + generate the changelog. .cjs so it loads under both
// CommonJS and ESM "type":"module" package setups.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Allowed commit types. `feat` -> minor, `fix` -> patch, `!`/BREAKING -> major.
    "type-enum": [
      2,
      "always",
      [
        "feat", // new feature
        "fix", // bug fix
        "docs", // documentation only
        "style", // formatting, no code change
        "refactor", // neither a fix nor a feature
        "perf", // performance improvement
        "test", // adding/fixing tests
        "build", // build system / deps
        "ci", // CI configuration
        "chore", // maintenance, tooling
        "revert", // revert a previous commit
      ],
    ],
    "subject-case": [0], // allow any case in the subject line
    "body-max-line-length": [0], // co-author trailers can be long
    "footer-max-line-length": [0],
  },
};
