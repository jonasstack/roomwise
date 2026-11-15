// Writes a card config (JSON file) into our own dashboard "grundriss-test" as a panel view.
import { readFileSync } from 'node:fs';
import { connect } from './ha.mjs';
const card = JSON.parse(readFileSync(process.argv[2] ?? 'examples/demo.json', 'utf8'));
const ha = await connect();
try {
  await ha.call({
    type: 'lovelace/config/save',
    url_path: 'grundriss-test',
    config: { title: 'Grundriss', views: [{ title: 'Grundriss', path: 'grundriss', panel: true, cards: [card] }] },
  });
  console.log('dashboard grundriss-test updated');
} finally {
  ha.close();
}
