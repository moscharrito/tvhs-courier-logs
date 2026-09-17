/* Entry point. Expo's registerRootComponent handles both the bare and the
   managed runtime, so this is the whole of it. */
import { registerRootComponent } from 'expo';
import { App } from './src/App';

registerRootComponent(App);
