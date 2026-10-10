export default function SectionTitle({ number, title, detail }) {
  return <div className="section-title"><span className="step-number">{number}</span><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div></div>
}
