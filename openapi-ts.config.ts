import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig([
  {
    input: './specs/anthropic.yml',
    output: './src/schemas/generated/anthropic',
    plugins: [
      { name: '@hey-api/typescript', enums: false },
      { name: 'zod', definitions: true, requests: false, responses: false },
    ],
  },
  {
    input: './specs/openai.yaml',
    output: './src/schemas/generated/openai',
    plugins: [
      { name: '@hey-api/typescript', enums: false },
      { name: 'zod', definitions: true, requests: false, responses: false },
    ],
  },
]);
