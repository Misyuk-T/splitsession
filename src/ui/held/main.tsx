import { render } from "preact";

import { Held } from "./Held";

import "../theme.css";
import "../components.css";
import "./held.css";

render(<Held />, document.getElementById("app")!);
