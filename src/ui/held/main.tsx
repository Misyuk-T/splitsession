import { render } from 'preact';
import '../theme.css';
import '../components.css';
import './held.css';
import { Held } from './Held';

render(<Held />, document.getElementById('app')!);
