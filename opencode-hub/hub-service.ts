import { compute } from '@prisma/composer-prisma-cloud';
import node from '@prisma/composer/node';
import { rawHttp, rawHttpContract } from '@prisma/composer/http';
import { z } from 'zod';
import { secretString } from '@prisma/composer/zod';

const hubInput = z.object({
  opencodeUrl: z.string(),
  opencodePassword: secretString(),
});

export default compute({
  name: 'hub',
  deps: { data: rawHttp() },
  input: hubInput,
  expose: { http: rawHttpContract },
  build: node({
    module: import.meta.url,
    entry: './dist/hub-server.js',
    dev: ['bun', 'hub-server.ts'],
  }),
});
