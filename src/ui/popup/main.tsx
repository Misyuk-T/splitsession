import { render } from 'preact';
import '../theme.css';
import '../components.css';
import './popup.css';
import { Popup } from './Popup';

render(<Popup />, document.getElementById('app')!);
