import { render } from 'preact';
import '../theme.css';
import '../components.css';
import './options.css';
import { Options } from './Options';

render(<Options />, document.getElementById('app')!);
