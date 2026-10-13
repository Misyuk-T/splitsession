import { render } from "preact";

import { Options } from "./Options";

import "../theme.css";
import "../components.css";
import "./options.css";

render(<Options />, document.getElementById("app")!);
