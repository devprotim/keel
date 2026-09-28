import { describeDocStoreContract } from './store.contract.ts';
import { MemoryDocStore } from './store.ts';

describeDocStoreContract('MemoryDocStore', async () => new MemoryDocStore());
