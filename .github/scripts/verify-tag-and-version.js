import pkg from "../../package.json" with { type: "json" };

const packageVersion = pkg.version;
const refName = process.env.GITHUB_REF_NAME;

if (refName !== `v${packageVersion}`) {
  console.error(
    `::error::Tag ${refName} does not match package version ${packageVersion}`,
  );
  process.exit(1);
}
