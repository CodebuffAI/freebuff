import { appRoot } from '@prisma/composer';
import { variable } from '@prisma/composer-prisma-cloud';
import hubService from './opencode-hub/hub-service.ts';
import dataService from './opencode-hub/data-service.ts';

export default appRoot('opencode-hub', ({ provision }) => {
  const opencodePassword = provision(variable.secret({ name: 'OPENCODE_SERVER_PASSWORD' }));
  const data = provision(dataService, {
    input: { allowOrigin: 'http://127.0.0.1:3000' },
  });
  provision(hubService, {
    deps: { data: data.http },
    input: {
      opencodeUrl: 'http://127.0.0.1:4096',
      opencodePassword,
    },
  });
});
