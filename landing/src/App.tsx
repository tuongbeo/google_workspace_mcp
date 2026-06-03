import { BrowserRouter, Routes, Route } from 'react-router-dom'
import LandingPage from './LandingPage'
import PrivacyPage from './PrivacyPage'
import TermsPage from './TermsPage'
import './index.css'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
      </Routes>
    </BrowserRouter>
  )
}
