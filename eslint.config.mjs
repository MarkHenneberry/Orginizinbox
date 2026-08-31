import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  { ignores: ["app/.well-known/workflow/**", ".workflow-data/**", ".workflow-vitest/**"] },
  ...nextVitals,
  ...nextTs
];

export default eslintConfig;
