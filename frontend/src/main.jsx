import "./utils/suppressThirdPartyLogs"; // Must be first – patches console before any lib loads
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <App />
)
