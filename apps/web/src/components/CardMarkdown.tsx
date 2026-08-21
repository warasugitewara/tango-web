import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'

export function CardMarkdown(props: { text: string }) {
  return (
    <div className="card-markdown">
      <ReactMarkdown skipHtml rehypePlugins={[rehypeSanitize]}>
        {props.text}
      </ReactMarkdown>
    </div>
  )
}
