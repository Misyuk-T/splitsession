import { render } from 'preact';
import '../theme.css';
import '../components.css';
import './choose.css';
import { Choose } from './Choose';

render(<Choose />, document.getElementById('app')!);
