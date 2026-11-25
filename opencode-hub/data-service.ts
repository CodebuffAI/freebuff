import { compute } from '@prisma/composer-prisma-cloud';
import node from '@prisma/composer/node';
import { rawHttpContract } from '@prisma/composer/http';
import { z } from 'zod';
import { field } from '@prisma/composer/zod';

const dataInput = z.object({
  allowOrigin: z.string(),
});

export default compute({
  name: 'data',
  deps: {},
  input: dataInput,
  expose: { http: rawHttpContract },
  build: node({
    module: import.meta.url,
    entry: './dist/data-server.js',
    dev: ['bun', 'data-server.ts'],
  }),
});
