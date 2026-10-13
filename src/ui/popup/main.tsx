import { render } from "preact";

import { Popup } from "./Popup";

import "../theme.css";
import "../components.css";
import "./popup.css";

render(<Popup />, document.getElementById("app")!);
